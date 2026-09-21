import type {DisposeReport} from "../contracts/models.ts";

interface Effect {
  label: string;
  release: () => void | Promise<void>;
  released: boolean;
}

export class EffectLedger {
  readonly generation: number;
  readonly slot: string;
  #effects: Effect[] = [];
  #report?: Promise<DisposeReport>;

  constructor(input: {slot: string; generation: number}) {
    this.slot = input.slot;
    this.generation = input.generation;
  }

  get size(): number { return this.#effects.filter((effect) => !effect.released).length; }

  register(label: string, release: () => void | Promise<void>): () => Promise<DisposeReport> {
    const effect: Effect = {label, release, released: false};
    this.#effects.push(effect);
    return () => this.dispose();
  }

  dispose(): Promise<DisposeReport> {
    this.#report ??= this.#dispose();
    return this.#report;
  }

  async #dispose(): Promise<DisposeReport> {
    const errors: string[] = [];
    let released = 0;
    for (const effect of [...this.#effects].reverse()) {
      if (effect.released) continue;
      try {
        await effect.release();
        effect.released = true;
        released += 1;
      } catch (error) {
        errors.push(`${effect.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      generation: this.generation,
      slot: this.slot,
      attempted: this.#effects.length,
      released,
      remaining: this.#effects.filter((effect) => !effect.released).map((effect) => effect.label),
      errors,
      timedOut: false,
      completedAt: new Date().toISOString()
    };
  }
}
