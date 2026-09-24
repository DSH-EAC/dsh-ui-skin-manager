import {LIFECYCLE_DEADLINES} from "../contracts/constants.ts";
import type {DisposeReport} from "../contracts/models.ts";
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
  preload?(context: LifecycleContext): void | Promise<void>;
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

export type LifecycleStage = "inspect" | "prepare" | "preload" | "activate" | "health" | "commit" | "rollback" | "dispose";

export interface LifecycleDeadlines {
  inspect: number;
  prepareAndPreload: number;
  activate: number;
  health: number;
  commit: number;
  deactivateAndDispose: number;
}

// ADR 0002 section 4. `inspect` only parses the envelope and `commit` is a local atomic rename, so both are
// bounded by the nearest declared stage deadline rather than being unbounded.
export const ADR_DEADLINES: LifecycleDeadlines = {
  inspect: LIFECYCLE_DEADLINES.prepareAndPreload,
  prepareAndPreload: LIFECYCLE_DEADLINES.prepareAndPreload,
  activate: LIFECYCLE_DEADLINES.activate,
  health: LIFECYCLE_DEADLINES.health,
  commit: LIFECYCLE_DEADLINES.health,
  deactivateAndDispose: LIFECYCLE_DEADLINES.deactivateAndDispose
};

const STAGE_DEADLINE: Record<LifecycleStage, keyof LifecycleDeadlines> = {
  inspect: "inspect",
  prepare: "prepareAndPreload",
  preload: "prepareAndPreload",
  activate: "activate",
  health: "health",
  commit: "commit",
  rollback: "deactivateAndDispose",
  dispose: "deactivateAndDispose"
};

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

export class LifecycleStageError extends Error {
  readonly stage: LifecycleStage;
  readonly slot: string;
  readonly generation: number;
  readonly report: DisposeReport;

  constructor(stage: LifecycleStage, slot: string, generation: number, cause: unknown, report: DisposeReport) {
    super(`${stage}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "LifecycleStageError";
    this.stage = stage;
    this.slot = slot;
    this.generation = generation;
    this.report = report;
    this.cause = cause;
  }
}

export class SlotLifecycle {
  readonly deadlines: LifecycleDeadlines;

  constructor(options: {timeoutMs?: number; deadlines?: Partial<LifecycleDeadlines>} = {}) {
    const base: LifecycleDeadlines = options.timeoutMs === undefined ? {...ADR_DEADLINES} : {
      inspect: options.timeoutMs,
      prepareAndPreload: options.timeoutMs,
      activate: options.timeoutMs,
      health: options.timeoutMs,
      commit: options.timeoutMs,
      deactivateAndDispose: options.timeoutMs
    };
    this.deadlines = {...base, ...options.deadlines};
    for (const key of Object.keys(this.deadlines) as (keyof LifecycleDeadlines)[]) {
      const value = this.deadlines[key];
      if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${key} deadline must be positive`);
      this.deadlines[key] = Math.min(value, ADR_DEADLINES[key]);
    }
  }

  // A package may request a shorter deadline; the ADR maxima above can never be raised by configuration.
  deadline(stage: LifecycleStage): number {
    return this.deadlines[STAGE_DEADLINE[stage]];
  }

  async switch(request: SwitchRequest): Promise<{state: "active"; generation: number}> {
    const controller = new AbortController();
    const ledger = request.ledger ?? new EffectLedger({
      slot: request.slot,
      generation: request.generation,
      timeoutMs: this.deadline("dispose")
    });
    const context: LifecycleContext = {signal: controller.signal, ledger, slot: request.slot, generation: request.generation};
    let stage: LifecycleStage = "inspect";
    let staged = false;
    let cause: unknown;
    try {
      await this.#run("inspect", request.hooks.inspect, context, controller);
      stage = "prepare";
      await this.#run("prepare", request.hooks.prepare, context, controller);
      staged = true;
      if (request.hooks.preload) {
        stage = "preload";
        await this.#run("preload", request.hooks.preload, context, controller);
      }
      stage = "activate";
      await this.#run("activate", request.hooks.activate, context, controller);
      stage = "health";
      await this.#run("health", request.hooks.health, context, controller);
      stage = "commit";
      await this.#run("commit", request.hooks.commit, context, controller);
      stage = "dispose";
      await request.active?.deactivate();
      return {state: "active", generation: request.generation};
    } catch (error) {
      cause = error;
      controller.abort(error);
    }
    const errors: string[] = [];
    if (staged) {
      try {
        await this.#run("rollback", request.hooks.rollback, context, controller);
      } catch (error) {
        errors.push(`rollback: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const report = await ledger.dispose({timeoutMs: this.deadline("dispose")});
    throw new LifecycleStageError(stage, request.slot, request.generation, cause, {...report, errors: [...report.errors, ...errors]});
  }

  async #run(stage: LifecycleStage, hook: (context: LifecycleContext) => void | Promise<void>, context: LifecycleContext, controller: AbortController): Promise<void> {
    const timeoutMs = this.deadline(stage);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new LifecycleTimeoutError(stage, timeoutMs);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      await Promise.race([Promise.resolve().then(() => hook(context)), deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
