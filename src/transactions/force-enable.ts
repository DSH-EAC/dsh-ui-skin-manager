import {LIFECYCLE_DEADLINES} from "../contracts/constants.ts";

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
  request: ForceEnableRequest;
  settle: (state: "kept" | "restored") => void;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout> | undefined;
}

export class ForceEnableController {
  readonly now: () => number;
  readonly timeoutMs: number;
  readonly onRestoreFailure: ((slot: string, error: Error) => void) | undefined;
  #active = new Map<string, string>();
  #pending = new Map<string, PendingRecord>();

  constructor(options: {now?: () => number; timeoutMs?: number; onRestoreFailure?: (slot: string, error: Error) => void} = {}) {
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? LIFECYCLE_DEADLINES.forceEnableConfirmation;
    this.onRestoreFailure = options.onRestoreFailure;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new RangeError("timeoutMs must be positive");
  }

  active(slot: string): string | undefined { return this.#active.get(slot); }

  pending(slot?: string): PendingForceEnable[] {
    const records = [...this.#pending.values()];
    return slot === undefined ? records : records.filter((record) => record.slot === slot);
  }

  begin(request: ForceEnableRequest): PendingForceEnable {
    if (this.#pending.has(request.slot)) throw new Error(`FORCE_ENABLE_PENDING: ${request.slot}`);
    this.#active.set(request.slot, request.target);
    let settle!: (state: "kept" | "restored") => void;
    const done = new Promise<"kept" | "restored">((resolve) => { settle = resolve; });
    const record: PendingRecord = {
      state: "pending",
      slot: request.slot,
      target: request.target,
      previous: request.previous,
      expiresAt: this.now() + this.timeoutMs,
      done,
      request,
      settled: false,
      timer: undefined,
      settle: (state) => {
        if (record.settled) return;
        record.settled = true;
        if (record.timer !== undefined) clearTimeout(record.timer);
        settle(state);
      }
    };
    this.#pending.set(request.slot, record);
    const timer = setTimeout(() => { void this.expire(request.slot); }, this.timeoutMs);
    timer.unref?.();
    record.timer = timer;
    // Activation runs before the confirmation window can be closed, so a later keep() always sees staged output.
    let activation: void | Promise<void>;
    try {
      activation = request.activate();
    } catch {
      void this.#restore(record);
      return record;
    }
    void Promise.resolve(activation).then(() => undefined, () => this.#restore(record));
    return record;
  }

  async keep(slot: string): Promise<"kept" | "restored"> {
    const record = this.#pending.get(slot);
    if (!record) throw new Error(`FORCE_ENABLE_NOT_PENDING: ${slot}`);
    try {
      // The record stays pending while `commit` runs. Deleting it first means the expiry timer can no longer find
      // it, so a commit that outlives the confirmation window would leave the forced target live with nothing
      // left that could restore it - the one case the 30 seconds exists to catch.
      await record.request.commit();
    } catch {
      await this.#restore(record);
      return record.done;
    }
    if (record.settled) return record.done;
    this.#pending.delete(slot);
    record.settle("kept");
    return record.done;
  }

  async expire(slot: string): Promise<void> {
    const record = this.#pending.get(slot);
    if (!record || this.now() < record.expiresAt) return;
    await this.#restore(record);
  }

  async expireImmediately(slot: string): Promise<void> {
    const record = this.#pending.get(slot);
    if (record) await this.#restore(record);
  }

  async crashRecover(): Promise<void> {
    await Promise.all([...this.#pending.values()].map((record) => this.#restore(record)));
  }

  recoverPending(): void {
    for (const record of [...this.#pending.values()]) void this.#restore(record);
  }

  async #restore(record: PendingRecord): Promise<void> {
    if (record.settled) return;
    this.#pending.delete(record.slot);
    this.#active.set(record.slot, record.previous);
    try {
      await record.request.restore();
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      try {
        this.onRestoreFailure?.(record.slot, error);
      } catch {
        /* a failing fault sink must not strand the confirmation window */
      }
    } finally {
      // "restored" records that the window closed by restoring, not that the restore was verified: a `restore()`
      // that threw is reported through `onRestoreFailure`, which is where the manager learns the original binding
      // is still not on screen and records the non-recoverable fault.
      record.settle("restored");
    }
  }
}
