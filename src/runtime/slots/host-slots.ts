import type {HostProfile, SlotDescriptor} from "../../contracts/models.ts";
import {EffectLedger} from "../../lifecycle/effect-ledger.ts";
import {createRuntimeContext, type RuntimeMountResult, type RuntimeSlotContext} from "./runtime-types.ts";

export interface HostMount {
  appendStyle?: (key: string, css: string) => void;
  removeStyle?: (key: string) => void;
}

export interface HostSlotSurface {
  mount(slot: string): HostMount;
  showError(fault: Error): void;
  supportsCapability(capability: string): boolean;
}

export interface HostSlotMountRequest {
  slot: string;
  kind: string;
  scope: string;
  capabilities: string[];
  generation: number;
  component(input: {context: RuntimeSlotContext}): void | Promise<void>;
}

export class SlotCompatibilityError extends Error {
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "SlotCompatibilityError";
  }
}

export class HostSlotRuntimeAdapter {
  readonly profile: HostProfile;
  readonly host: HostSlotSurface;
  readonly timeoutMs: number;
  #current = new Map<string, number>();

  constructor(options: {profile: HostProfile; host: HostSlotSurface; timeoutMs: number}) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new RangeError("timeoutMs must be positive");
    this.profile = options.profile;
    this.host = options.host;
    this.timeoutMs = options.timeoutMs;
  }

  async mount(request: HostSlotMountRequest): Promise<RuntimeMountResult> {
    const descriptor = this.profile.slots.find((candidate) => candidate.id === request.slot);
    if (!descriptor) throw new SlotCompatibilityError("COMPATIBILITY_SLOT_UNKNOWN", request.slot);
    this.#validate(descriptor, request);
    const controller = new AbortController();
    const ledger = new EffectLedger({slot: request.slot, generation: request.generation});
    const mount = this.host.mount(request.slot);
    const styles = new Set<string>();
    const context = createRuntimeContext({
      slot: request.slot,
      generation: request.generation,
      ledger,
      signal: controller.signal,
      current: () => this.#current.get(request.slot) ?? request.generation,
      replaceStyle: (key, css) => {
        mount.appendStyle?.(key, css);
        styles.add(key);
        ledger.register(`style:${key}`, () => {
          mount.removeStyle?.(key);
          styles.delete(key);
        });
      }
    });
    try {
      await this.#bounded(request.component({context}), controller);
      this.#current.set(request.slot, request.generation);
      return {
        state: "active",
        slot: request.slot,
        generation: request.generation,
        ledger,
        isCurrent: (generation = request.generation) => context.isCurrent(generation),
        dispose: async () => {
          controller.abort();
          const report = await ledger.dispose();
          if (this.#current.get(request.slot) === request.generation) this.#current.delete(request.slot);
          return report;
        }
      };
    } catch (error) {
      controller.abort(error);
      await ledger.dispose();
      this.host.showError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  #validate(descriptor: SlotDescriptor, request: HostSlotMountRequest): void {
    if (descriptor.kind !== request.kind) throw new SlotCompatibilityError("COMPATIBILITY_SLOT_KIND", `${request.slot} expects ${descriptor.kind}`);
    if (descriptor.scope !== request.scope) throw new SlotCompatibilityError("COMPATIBILITY_SLOT_SCOPE", `${request.slot} expects ${descriptor.scope}`);
    for (const capability of request.capabilities) {
      if (!descriptor.capabilities.includes(capability) || !this.host.supportsCapability(capability)) {
        throw new SlotCompatibilityError("CAPABILITY_MISSING", capability);
      }
    }
  }

  async #bounded<T>(value: T | Promise<T>, controller: AbortController): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve(value),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { const error = new Error(`TIMEOUT_INITIALIZE after ${this.timeoutMs}ms`); controller.abort(error); reject(error); }, this.timeoutMs); })
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
