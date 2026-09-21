import {EffectLedger} from "../../lifecycle/effect-ledger.ts";
import {ThemeRegistry} from "../theme/theme-registry.ts";

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

export class DshClientRuntimeAdapter {
  readonly version: string;
  readonly mappings: DshSlotMapping[];

  constructor(options: {version: string; mappings: DshSlotMapping[]}) {
    this.version = options.version;
    this.mappings = options.mappings;
  }

  createContext(input: DshContextInput): {
    readonly theme: {register(name: string, value: unknown): () => void | Promise<void>};
    readonly slots: {register(key: string, descriptor: {kind: string; scope: string}): () => void | Promise<void>};
    dispose(): Promise<void>;
  } {
    const mapping = this.mappings.find((candidate) => candidate.slot === input.slot);
    if (!mapping) throw new Error(`COMPATIBILITY_DSH_SLOT_UNKNOWN: ${input.slot}`);
    const ledger = new EffectLedger({slot: input.slot, generation: input.generation});
    const theme = {
      register: (name: string, value: unknown) => {
        const disposer = input.theme.register(name, value);
        return ledger.register(`theme:${name}`, async () => { await disposer(); });
      }
    };
    const slots = {
      register: (key: string, descriptor: {kind: string; scope: string}) => {
        if (key !== mapping.key || descriptor.kind !== mapping.kind || descriptor.scope !== mapping.scope) {
          throw new Error("COMPATIBILITY_DSH_SLOT_SHAPE");
        }
        const disposer = input.slots.register(key, descriptor);
        return ledger.register(`slot:${key}`, async () => { await disposer(); });
      }
    };
    return {theme, slots, dispose: async () => { await ledger.dispose(); }};
  }

  static withThemeRegistry(options: {version: string; mappings: DshSlotMapping[]}): {adapter: DshClientRuntimeAdapter; theme: ThemeRegistry} {
    return {adapter: new DshClientRuntimeAdapter(options), theme: new ThemeRegistry()};
  }
}
