export interface ForceEnableRequest {
  slot: string;
  target: string;
  previous: string;
  activate: () => void | Promise<void>;
  restore: () => void | Promise<void>;
  commit: () => void | Promise<void>;
}

export interface PendingForceEnable {
  readonly state: "pending";
  readonly slot: string;
  readonly target: string;
  readonly previous: string;
  readonly expiresAt: number;
  readonly done: Promise<"kept" | "restored">;
}

interface PendingRecord extends PendingForceEnable {
  resolve: (state: "kept" | "restored") => void;
  request: ForceEnableRequest;
}

export class ForceEnableController {
  readonly now: () => number;
  readonly timeoutMs: number;
  #active = new Map<string, string>();
  #pending = new Map<string, PendingRecord>();

  constructor(options: {now?: () => number; timeoutMs?: number} = {}) {
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new RangeError("timeoutMs must be positive");
  }

  active(slot: string): string | undefined { return this.#active.get(slot); }

  begin(request: ForceEnableRequest): PendingForceEnable {
    if (this.#pending.has(request.slot)) throw new Error(`FORCE_ENABLE_PENDING: ${request.slot}`);
    this.#active.set(request.slot, request.target);
    const expiresAt = this.now() + this.timeoutMs;
    let resolve!: (state: "kept" | "restored") => void;
    const done = new Promise<"kept" | "restored">((finish) => { resolve = finish; });
    const pending: PendingRecord = {state: "pending", slot: request.slot, target: request.target, previous: request.previous, expiresAt, done, resolve, request};
    this.#pending.set(request.slot, pending);
    try {
      Promise.resolve(request.activate()).catch(() => this.expireImmediately(request.slot));
    } catch {
      void this.expireImmediately(request.slot);
    }
    return pending;
  }

  keep(slot: string): void {
    const pending = this.#pending.get(slot);
    if (!pending) throw new Error(`FORCE_ENABLE_NOT_PENDING: ${slot}`);
    this.#pending.delete(slot);
    Promise.resolve(pending.request.commit()).then(() => pending.resolve("kept"), () => this.restorePending(pending));
  }

  async expire(slot: string): Promise<void> {
    const pending = this.#pending.get(slot);
    if (!pending || this.now() < pending.expiresAt) return;
    await this.restorePending(pending);
  }

  async expireImmediately(slot: string): Promise<void> {
    const pending = this.#pending.get(slot);
    if (pending) await this.restorePending(pending);
  }

  recoverPending(): void {
    for (const pending of this.#pending.values()) void this.restorePending(pending);
  }

  async crashRecover(): Promise<void> { this.recoverPending(); }

  async restorePending(pending: PendingRecord): Promise<void> {
    if (!this.#pending.delete(pending.slot)) return;
    this.#active.set(pending.slot, pending.previous);
    try { await pending.request.restore(); } finally { pending.resolve("restored"); }
  }
}
