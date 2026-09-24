import type {SlotBinding} from "../contracts/models.ts";

// A hook receives the signal of the transaction it belongs to. A stage that runs past its deadline is not merely
// slow: its side effects are still on their way, and rolling back around them lets an abandoned publish land
// after the restore that undid it. The signal is how a context is told to stop, and the drain in `#run` is how
// the coordinator waits for it to have stopped.
export type TransactionHook = (binding: SlotBinding | undefined, signal: AbortSignal) => void | Promise<void>;

export interface SlotTransactionContext {
  id: string;
  prepare?: TransactionHook;
  preload?: TransactionHook;
  activate?: TransactionHook;
  health?: TransactionHook;
  commit?: TransactionHook;
  rollback?: TransactionHook;
  disposeOld?: TransactionHook;
}

export interface SlotTransactionRequest {
  slot: string;
  binding: SlotBinding;
  contexts: SlotTransactionContext[];
  previous?: {binding: SlotBinding; dispose?: TransactionHook};
  persist?: (binding: SlotBinding) => void | Promise<void>;
}

export interface SlotTransactionResult {
  state: "active";
  binding: SlotBinding;
  generation: number;
  // Cleanup that ran after the commit point. ADR 0002 section 4: a residue here is a disposal failure the
  // caller must quarantine, but it can never un-publish the generation that is already persisted.
  disposeErrors: string[];
}

// Everything sharing one abort. `failure` keeps the first deadline miss so a sibling hook that rejects because it
// was told to stop cannot be reported as the cause of the transaction failing.
interface TransactionRun {
  signal: AbortSignal;
  abort: (reason: string) => void;
  failure?: TransactionStageError;
}

export class TransactionStageError extends Error {
  readonly stage: string;
  readonly context?: string;
  readonly timedOut: boolean;
  // True when the stage was aborted and had not stopped by the end of the grace period: something may still be
  // on its way into a slot this transaction has already given back to its previous generation.
  readonly abandoned: boolean;

  constructor(stage: string, cause: unknown, options: {context?: string; timedOut?: boolean; abandoned?: boolean} = {}) {
    const {context, timedOut = false, abandoned = false} = options;
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`${stage}${context ? ` (${context})` : ""}: ${message}`);
    this.name = "TransactionStageError";
    this.stage = stage;
    if (context !== undefined) this.context = context;
    this.timedOut = timedOut;
    this.abandoned = abandoned;
    this.cause = cause;
  }
}

export class SlotTransactionCoordinator {
  readonly timeoutMs: number;
  readonly abandonGraceMs: number;
  #active = new Map<string, SlotBinding>();
  #queues = new Map<string, Promise<unknown>>();

  constructor(options: {timeoutMs: number; abandonGraceMs?: number}) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new RangeError("timeoutMs must be positive");
    this.timeoutMs = options.timeoutMs;
    this.abandonGraceMs = options.abandonGraceMs ?? options.timeoutMs;
    if (!Number.isFinite(this.abandonGraceMs) || this.abandonGraceMs <= 0) throw new RangeError("abandonGraceMs must be positive");
  }

  active(slot: string): SlotBinding | undefined {
    const value = this.#active.get(slot);
    return value ? structuredClone(value) : undefined;
  }

  switch(request: SlotTransactionRequest): Promise<SlotTransactionResult> {
    const prior = this.#queues.get(request.slot) ?? Promise.resolve();
    const run = prior.then(() => this.#switch(request));
    this.#queues.set(request.slot, run.then(() => undefined, () => undefined));
    return run;
  }

  async #switch(request: SlotTransactionRequest): Promise<SlotTransactionResult> {
    const current = this.#active.get(request.slot) ?? request.previous?.binding;
    if (current && request.binding.generation <= current.generation) {
      throw new TransactionStageError("generation", new Error(`generation ${request.binding.generation} is not newer than ${current.generation}`));
    }
    const previous = current ? {binding: structuredClone(current), dispose: request.previous?.dispose} : undefined;
    const participants = [...request.contexts];
    const staging = SlotTransactionCoordinator.#openRun();
    // Compensation runs on a signal nobody can abort: a rollback or a disposal that checks `signal.aborted` must
    // not talk itself out of releasing the effects the failed stage registered.
    const settling = SlotTransactionCoordinator.#openRun();
    let committed: SlotBinding;
    try {
      for (const stage of ["prepare", "preload", "activate", "health"] as const) {
        await Promise.all(participants.map((context) => this.#run(stage, context.id, (signal) => context[stage]?.(request.binding, signal), staging)));
      }
      await Promise.all(participants.map((context) => this.#run("commit", context.id, (signal) => context.commit?.(request.binding, signal), staging)));
      committed = structuredClone({...request.binding, state: "active"} satisfies SlotBinding);
      await this.#run("commit-persistence", request.slot, () => request.persist?.(committed), staging);
    } catch (cause) {
      for (const context of [...participants].reverse()) {
        await this.#run("rollback", context.id, (signal) => context.rollback?.(request.binding, signal), settling).then(() => undefined, () => undefined);
      }
      if (previous) this.#active.set(request.slot, previous.binding);
      else this.#active.delete(request.slot);
      throw cause;
    }
    this.#active.set(request.slot, committed);
    const disposeErrors: string[] = [];
    const cleanup: Array<{id: string; invoke: (signal: AbortSignal) => void | Promise<void>}> = participants
      .filter((context) => context.disposeOld !== undefined)
      .map((context) => ({id: context.id, invoke: (signal) => context.disposeOld!(committed, signal)}));
    if (previous && request.previous?.dispose) {
      const dispose = request.previous.dispose;
      cleanup.push({id: "previous", invoke: (signal) => dispose(previous.binding, signal)});
    }
    for (const step of cleanup) {
      try {
        await this.#run("dispose-old", step.id, step.invoke, settling);
      } catch (error) {
        disposeErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return {state: "active", binding: structuredClone(committed), generation: committed.generation, disposeErrors};
  }

  async #run(stage: string, context: string, invoke: (signal: AbortSignal) => void | Promise<void>, run: TransactionRun): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const task = Promise.resolve().then(() => invoke(run.signal));
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TransactionStageError(stage, new Error(`timed out after ${this.timeoutMs}ms`), {context, timedOut: true})), this.timeoutMs);
    });
    try {
      await Promise.race([task, deadline]);
    } catch (cause) {
      // The first deadline miss in this abort owns the diagnosis. A sibling hook that rejects because it was told
      // to stop is a symptom, and reporting it would send a reader to the wrong stage.
      const failure = run.failure ?? (cause instanceof TransactionStageError && cause.timedOut ? cause : undefined);
      if (failure === undefined) {
        if (cause instanceof TransactionStageError) throw cause;
        throw new TransactionStageError(stage, cause, {context});
      }
      run.abort(failure.message);
      run.failure = failure;
      // Give the abandoned work a chance to notice before the caller rolls back around it. If the grace period
      // runs out first the hook ignored its abort, and that is reported rather than assumed to have stopped.
      // `failure.cause` is the unwrapped deadline; re-wrapping `failure.message` would quote the stage and its
      // context a second time.
      const gaveUp = await Promise.race([task.then(() => false, () => false), SlotTransactionCoordinator.#graceElapsed(this.abandonGraceMs)]);
      throw new TransactionStageError(failure.stage, failure.cause ?? new Error(failure.message), {timedOut: true, abandoned: gaveUp, ...(failure.context === undefined ? {} : {context: failure.context})});
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  static #openRun(): TransactionRun {
    const controller = new AbortController();
    return {signal: controller.signal, abort: (reason: string) => controller.abort(new Error(reason))};
  }

  // Resolves once the grace period has run out, which is how an abort that was ignored becomes reportable.
  static #graceElapsed(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), ms);
      timer.unref?.();
    });
  }
}
