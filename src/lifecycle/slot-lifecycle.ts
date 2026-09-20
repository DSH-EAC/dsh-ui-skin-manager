import {EffectLedger} from "./effect-ledger.ts";

export interface LifecycleContext {
  signal: AbortSignal;
  ledger: EffectLedger;
  slot: string;
  generation: number;
}

export interface LifecycleHooks {
  inspect(context: LifecycleContext): void | Promise<void>;
  prepare(context: LifecycleContext): void | Promise<void>;
  activate(context: LifecycleContext): void | Promise<void>;
  health(context: LifecycleContext): void | Promise<void>;
  commit(context: LifecycleContext): void | Promise<void>;
  rollback(context: LifecycleContext): void | Promise<void>;
}

export interface SwitchRequest {
  slot: string;
  generation: number;
  hooks: LifecycleHooks;
  ledger?: EffectLedger;
  active?: {deactivate(): void | Promise<void>};
}

export class LifecycleTimeoutError extends Error {
  readonly stage: string;
  readonly timeoutMs: number;

  constructor(stage: string, timeoutMs: number) {
    super(`${stage} timed out after ${timeoutMs}ms`);
    this.name = "LifecycleTimeoutError";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

export class SlotLifecycle {
  readonly timeoutMs: number;

  constructor(options: {timeoutMs: number}) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new RangeError("timeoutMs must be positive");
    this.timeoutMs = options.timeoutMs;
  }

  async switch(request: SwitchRequest): Promise<{state: "active"; generation: number}> {
    const controller = new AbortController();
    const ledger = request.ledger ?? new EffectLedger({slot: request.slot, generation: request.generation});
    const context: LifecycleContext = {signal: controller.signal, ledger, slot: request.slot, generation: request.generation};
    let staged = false;
    try {
      await this.#run("inspect", request.hooks.inspect, context, controller);
      await this.#run("prepare", request.hooks.prepare, context, controller);
      staged = true;
      await this.#run("activate", request.hooks.activate, context, controller);
      await this.#run("health", request.hooks.health, context, controller);
      await this.#run("commit", request.hooks.commit, context, controller);
      await request.active?.deactivate();
      return {state: "active", generation: request.generation};
    } catch (error) {
      controller.abort(error);
      if (staged) {
        try { await request.hooks.rollback(context); } catch { /* original failure remains authoritative */ }
      }
      await ledger.dispose();
      throw error;
    }
  }

  async #run(stage: string, hook: (context: LifecycleContext) => void | Promise<void>, context: LifecycleContext, controller: AbortController): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new LifecycleTimeoutError(stage, this.timeoutMs);
        reject(error);
        controller.abort(error);
      }, this.timeoutMs);
    });
    try {
      await Promise.race([Promise.resolve().then(() => hook(context)), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
