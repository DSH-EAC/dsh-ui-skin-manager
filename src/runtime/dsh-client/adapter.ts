import {EffectLedger} from "../../lifecycle/effect-ledger.ts";

export interface DshSlotMapping {
  slot: string;
  key: string;
  kind: string;
  scope: string;
}

export interface DshContextInput {
  slot: string;
  generation: number;
  theme: {register(name: string, value: unknown): () => void | Promise<void>};
  slots: {register(key: string, descriptor: {kind: string; scope: string}): () => void | Promise<void>};
}

export type DshDisposer = () => Promise<void>;

export class DshClientRuntimeAdapter {
  readonly version: string;
  readonly mappings: DshSlotMapping[];

  constructor(options: {version: string; mappings: DshSlotMapping[]}) {
    this.version = options.version;
    this.mappings = options.mappings;
  }

  createContext(input: DshContextInput): {
    readonly theme: {register(name: string, value: unknown): DshDisposer};
    readonly slots: {register(key: string, descriptor: {kind: string; scope: string}): DshDisposer};
    dispose(): Promise<void>;
  } {
    const mapping = this.mappings.find((candidate) => candidate.slot === input.slot);
    if (!mapping) throw new Error(`COMPATIBILITY_DSH_SLOT_UNKNOWN: ${input.slot}`);
    const ledger = new EffectLedger({slot: input.slot, generation: input.generation});
    const track = (label: string, dispose: () => void | Promise<void>): DshDisposer => {
      ledger.register(label, async () => { await dispose(); });
      return async () => { await ledger.dispose(); };
    };
    const theme = {
      register: (name: string, value: unknown) => track(`theme:${name}`, input.theme.register(name, value))
    };
    const slots = {
      register: (key: string, descriptor: {kind: string; scope: string}) => {
        if (key !== mapping.key || descriptor.kind !== mapping.kind || descriptor.scope !== mapping.scope) {
          throw new Error("COMPATIBILITY_DSH_SLOT_SHAPE");
        }
        return track(`slot:${key}`, input.slots.register(key, descriptor));
      }
    };
    return {theme, slots, dispose: async () => { await ledger.dispose(); }};
  }
}
