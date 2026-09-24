import {EffectLedger} from "../../lifecycle/effect-ledger.ts";
import type {DisposeReport} from "../../contracts/models.ts";

export interface RuntimeSlotContext {
  readonly slot: string;
  readonly generation: number;
  readonly ledger: EffectLedger;
  readonly signal: AbortSignal;
  isCurrent(generation?: number): boolean;
  replaceStyle(key: string, css: string): void;
}

export interface RuntimeMountResult {
  readonly state: "active";
  readonly slot: string;
  readonly generation: number;
  readonly ledger: EffectLedger;
  isCurrent(generation?: number): boolean;
  dispose(): Promise<DisposeReport>;
}

export function createRuntimeContext(input: {
  slot: string;
  generation: number;
  ledger: EffectLedger;
  signal: AbortSignal;
  replaceStyle: (key: string, css: string) => void;
  current: () => number;
}): RuntimeSlotContext {
  const context: RuntimeSlotContext = {
    slot: input.slot,
    generation: input.generation,
    ledger: input.ledger,
    signal: input.signal,
    isCurrent: (generation = input.generation) => input.current() === generation && !input.signal.aborted,
    replaceStyle: (key: string, css: string) => {
      if (input.current() !== input.generation || input.signal.aborted) return;
      input.replaceStyle(key, css);
    }
  };
  return Object.freeze(context);
}
