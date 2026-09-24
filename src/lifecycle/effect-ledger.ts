import {LIFECYCLE_DEADLINES} from "../contracts/constants.ts";
import type {DisposeReport} from "../contracts/models.ts";

interface Effect {
  label: string;
  release: () => void | Promise<void>;
  released: boolean;
}

export interface DisposeOptions {
  timeoutMs?: number;
}

type ReleaseOutcome = {ok: true} | {ok: false; timedOut: boolean; message: string};

async function boundedRelease(label: string, release: () => void | Promise<void>, timeoutMs: number): Promise<ReleaseOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = Promise.resolve().then(async () => { await release(); });
  const deadline = new Promise<ReleaseOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ok: false, timedOut: true, message: `${label} timed out after ${timeoutMs}ms`}), timeoutMs);
  });
  try {
    const outcome = await Promise.race([attempt.then((): ReleaseOutcome => ({ok: true})), deadline]);
    if (!outcome.ok && outcome.timedOut) attempt.catch(() => undefined);
    return outcome;
  } catch (error) {
    return {ok: false, timedOut: false, message: `${label}: ${error instanceof Error ? error.message : String(error)}`};
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class EffectLedger {
  readonly generation: number;
  readonly slot: string;
  readonly timeoutMs: number;
  #effects: Effect[] = [];
  #report?: Promise<DisposeReport>;

  constructor(input: {slot: string; generation: number; timeoutMs?: number}) {
    this.slot = input.slot;
    this.generation = input.generation;
    this.timeoutMs = input.timeoutMs ?? LIFECYCLE_DEADLINES.deactivateAndDispose;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new RangeError("timeoutMs must be positive");
  }

  get size(): number { return this.#effects.filter((effect) => !effect.released).length; }

  get disposed(): boolean { return this.#report !== undefined; }

  register(label: string, release: () => void | Promise<void>): () => Promise<DisposeReport> {
    if (this.#report !== undefined) throw new Error(`DISPOSE_LEDGER_CLOSED: ${this.slot} generation ${this.generation}`);
    this.#effects.push({label, release, released: false});
    return () => this.dispose();
  }

  dispose(options: DisposeOptions = {}): Promise<DisposeReport> {
    this.#report ??= this.#dispose(options.timeoutMs ?? this.timeoutMs);
    return this.#report;
  }

  async #dispose(timeoutMs: number): Promise<DisposeReport> {
    const errors: string[] = [];
    let released = 0;
    let timedOut = false;
    for (const effect of [...this.#effects].reverse()) {
      if (effect.released) continue;
      const outcome = await boundedRelease(effect.label, effect.release, timeoutMs);
      if (outcome.ok) {
        effect.released = true;
        released += 1;
        continue;
      }
      if (outcome.timedOut) timedOut = true;
      errors.push(outcome.message);
    }
    return {
      generation: this.generation,
      slot: this.slot,
      attempted: this.#effects.length,
      released,
      remaining: this.#effects.filter((effect) => !effect.released).map((effect) => effect.label),
      errors,
      timedOut,
      completedAt: new Date().toISOString()
    };
  }
}
