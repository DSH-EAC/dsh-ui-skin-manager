import {mkdir, unlink} from "node:fs/promises";
import {join} from "node:path";
import type {SlotBinding} from "../contracts/models.ts";
import {AtomicJsonStore} from "../persistence/atomic-json-store.ts";

export interface BindingGeneration {generation: number; bindings: Record<string, SlotBinding>}
export interface BindingReadResult {value?: BindingGeneration; backupPath?: string; diagnostic?: string}
export interface QuarantineRecord {packageId: string; slot: string; reason: string; timestamp: string}

export class BindingStore {
  readonly directory: string;
  readonly committedPath: string;
  readonly pendingPath: string;
  readonly draftPath: string;
  readonly previousPath: string;
  constructor(directory: string) {
    this.directory = directory; this.committedPath = join(directory, "committed.json"); this.pendingPath = join(directory, "pending.json"); this.draftPath = join(directory, "selected-draft.json"); this.previousPath = join(directory, "previous-known-good.json");
  }
  async stage(value: BindingGeneration): Promise<void> { await new AtomicJsonStore<BindingGeneration>(this.pendingPath).write(value); }
  async selectDraft(value: BindingGeneration): Promise<void> { await new AtomicJsonStore<BindingGeneration>(this.draftPath).write(value); }
  async quarantine(packageId: string, slot: string, reason: string): Promise<void> {
    const result = await new AtomicJsonStore<QuarantineRecord[]>(join(this.directory, "quarantine.json")).read([]);
    const records = (result.value ?? []).filter((item) => !(item.packageId === packageId && item.slot === slot));
    records.push({packageId, slot, reason, timestamp: new Date().toISOString()});
    await new AtomicJsonStore<QuarantineRecord[]>(join(this.directory, "quarantine.json")).write(records);
  }
  async isQuarantined(packageId: string, slot: string): Promise<QuarantineRecord | undefined> {
    const result = await new AtomicJsonStore<QuarantineRecord[]>(join(this.directory, "quarantine.json")).read([]);
    return (result.value ?? []).find((item) => item.packageId === packageId && item.slot === slot);
  }
  async previousGenerations(): Promise<BindingGeneration[]> {
    const result = await new AtomicJsonStore<BindingGeneration[]>(join(this.directory, "previous-generations.json")).read([]);
    return (result.value ?? []).sort((left, right) => right.generation - left.generation).slice(0, 2);
  }
  async commit(value: BindingGeneration): Promise<void> {
    await mkdir(this.directory, {recursive: true});
    const current = await this.committed();
    if (current.value) {
      await new AtomicJsonStore<BindingGeneration>(this.previousPath).write(current.value);
      const history = await this.previousGenerations();
      const next = [current.value, ...history.filter((item) => item.generation !== current.value!.generation)].slice(0, 2);
      await new AtomicJsonStore<BindingGeneration[]>(join(this.directory, "previous-generations.json")).write(next);
    }
    await new AtomicJsonStore<BindingGeneration>(this.committedPath).write(value);
    await unlink(this.pendingPath).catch(() => undefined);
  }
  async committed(): Promise<BindingReadResult> { return this.#read(this.committedPath); }
  async pending(): Promise<BindingReadResult> { return this.#read(this.pendingPath); }
  async draft(): Promise<BindingReadResult> { return this.#read(this.draftPath); }
  async previous(): Promise<BindingReadResult> { return this.#read(this.previousPath); }
  async recover(): Promise<BindingGeneration> {
    const committed = await this.committed();
    await unlink(this.pendingPath).catch(() => undefined);
    if (committed.value) return committed.value;
    const previous = await this.previous();
    if (previous.value) return previous.value;
    return {generation: 0, bindings: {}};
  }
  async #read(path: string): Promise<BindingReadResult> {
    const result = await new AtomicJsonStore<BindingGeneration | undefined>(path).read(undefined);
    return {value: result.value, ...(result.backupPath ? {backupPath: result.backupPath} : {}), ...(result.diagnostic ? {diagnostic: result.diagnostic} : {})};
  }
}
