import type {SlotBinding} from "../contracts/models.ts";

export type TransactionHook = (binding?: SlotBinding) => void | Promise<void>;

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

export class TransactionStageError extends Error {
  readonly stage: string;
  readonly context?: string;

  constructor(stage: string, cause: unknown, context?: string) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`${stage}${context ? ` (${context})` : ""}: ${message}`);
    this.name = "TransactionStageError";
    this.stage = stage;
    if (context !== undefined) this.context = context;
    this.cause = cause;
  }
}

export class SlotTransactionCoordinator {
  readonly timeoutMs: number;
  #active = new Map<string, SlotBinding>();
  #queues = new Map<string, Promise<unknown>>();

  constructor(options: {timeoutMs: number}) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new RangeError("timeoutMs must be positive");
    this.timeoutMs = options.timeoutMs;
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
    let committed: SlotBinding;
    try {
      for (const stage of ["prepare", "preload", "activate", "health"] as const) {
        await Promise.all(participants.map((context) => this.#run(stage, context.id, () => context[stage]?.(request.binding))));
      }
      await Promise.all(participants.map((context) => this.#run("commit", context.id, () => context.commit?.(request.binding))));
      committed = structuredClone({...request.binding, state: "active"} satisfies SlotBinding);
      await this.#run("commit-persistence", request.slot, () => request.persist?.(committed));
    } catch (cause) {
      for (const context of [...participants].reverse()) {
        await this.#run("rollback", context.id, () => context.rollback?.(request.binding)).then(() => undefined, () => undefined);
      }
      if (previous) this.#active.set(request.slot, previous.binding);
      else this.#active.delete(request.slot);
      throw cause;
    }
    this.#active.set(request.slot, committed);
    const disposeErrors: string[] = [];
    const cleanup: Array<{id: string; invoke: () => void | Promise<void>}> = participants
      .filter((context) => context.disposeOld !== undefined)
      .map((context) => ({id: context.id, invoke: () => context.disposeOld!(committed)}));
    if (previous && request.previous?.dispose) {
      const dispose = request.previous.dispose;
      cleanup.push({id: "previous", invoke: () => dispose(previous.binding)});
    }
    for (const step of cleanup) {
      try {
        await this.#run("dispose-old", step.id, step.invoke);
      } catch (error) {
        disposeErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return {state: "active", binding: structuredClone(committed), generation: committed.generation, disposeErrors};
  }

  async #run(stage: string, context: string, invoke: () => void | Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TransactionStageError(stage, new Error(`timed out after ${this.timeoutMs}ms`), context)), this.timeoutMs);
    });
    try {
      await Promise.race([Promise.resolve().then(invoke), deadline]);
    } catch (cause) {
      if (cause instanceof TransactionStageError) throw cause;
      throw new TransactionStageError(stage, cause, context);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
