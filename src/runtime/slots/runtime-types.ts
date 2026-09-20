import {EffectLedger} from "../../lifecycle/effect-ledger.ts";

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
  dispose(): Promise<unknown>;
}

export function createRuntimeContext(input: {
  slot: string;
  generation: number;
  ledger: EffectLedger;
  signal: AbortSignal;
  replaceStyle: (key: string, css: string) => void;
  current: () => number;
}): RuntimeSlotContext {
  return Object.freeze({
    slot: input.slot,
    generation: input.generation,
    ledger: input.ledger,
    signal: input.signal,
    isCurrent: (generation = input.generation) => input.current() === generation && !input.signal.aborted,
    replaceStyle: input.replaceStyle
  });
}
