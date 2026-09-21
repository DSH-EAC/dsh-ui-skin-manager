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
    this.#queues.set(request.slot, run.catch(() => undefined));
    return run;
  }

  async #switch(request: SlotTransactionRequest): Promise<SlotTransactionResult> {
    const current = this.#active.get(request.slot) ?? request.previous?.binding;
    if (current && request.binding.generation <= current.generation) {
      throw new TransactionStageError("generation", new Error(`generation ${request.binding.generation} is not newer than ${current.generation}`));
    }
    const previous = current ? {binding: structuredClone(current), dispose: request.previous?.dispose} : undefined;
    const staged: SlotTransactionContext[] = [...request.contexts];
    try {
      for (const stage of ["prepare", "preload", "activate", "health"] as const) {
        await Promise.all(request.contexts.map(async (context) => {
          await this.#run(stage, context[stage], context.id);
          if (stage === "activate" && !staged.includes(context)) staged.push(context);
        }));
      }
      await Promise.all(request.contexts.map((context) => this.#run("commit", context.commit, context.id)));
      const committed = structuredClone({...request.binding, state: "active"});
      await this.#run("commit-persistence", request.persist, request.slot, committed);
      this.#active.set(request.slot, committed);
      await Promise.all(request.contexts.map((context) => this.#run("dispose-old", context.disposeOld, context.id)));
      await previous?.dispose?.();
      return {state: "active", binding: structuredClone(this.#active.get(request.slot)!), generation: request.binding.generation};
    } catch (cause) {
      await Promise.all([...staged].reverse().map((context) => this.#run("rollback", context.rollback, context.id).catch(() => undefined)));
      if (previous) this.#active.set(request.slot, previous.binding);
      else this.#active.delete(request.slot);
      throw cause;
    }
  }

  async #run(stage: string, hook: TransactionHook | undefined, context: string, ...args: [SlotBinding?]): Promise<void> {
    if (!hook) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TransactionStageError(stage, new Error(`timed out after ${this.timeoutMs}ms`), context)), this.timeoutMs);
    });
    try {
      await Promise.race([Promise.resolve().then(() => hook(...args)), timeout]);
    } catch (cause) {
      if (cause instanceof TransactionStageError) throw cause;
      throw new TransactionStageError(stage, cause, context);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
