import {mkdir, rename, unlink} from "node:fs/promises";
import {join} from "node:path";
import type {BindingGeneration, QuarantineRecord} from "../contracts/models.ts";
import {validateBindingGeneration, validateQuarantineRecords} from "../contracts/validation.ts";
import {AtomicJsonStore} from "../persistence/atomic-json-store.ts";

export type {BindingGeneration, QuarantineRecord};
export interface BindingReadResult {
  value?: BindingGeneration | undefined;
  absent?: boolean | undefined;
  backupPath?: string | undefined;
  diagnostic?: string | undefined;
}

const HISTORY_LIMIT = 2;

export class BindingStore {
  readonly directory: string;
  readonly committedPath: string;
  readonly pendingPath: string;
  readonly draftPath: string;
  readonly previousPath: string;
  readonly historyPath: string;
  readonly quarantinePath: string;

  constructor(directory: string) {
    this.directory = directory;
    this.committedPath = join(directory, "committed.json");
    this.pendingPath = join(directory, "pending.json");
    this.draftPath = join(directory, "selected-draft.json");
    this.previousPath = join(directory, "previous-known-good.json");
    this.historyPath = join(directory, "previous-generations.json");
    this.quarantinePath = join(directory, "quarantine.json");
  }

  async stage(value: BindingGeneration): Promise<void> {
    await mkdir(this.directory, {recursive: true});
    await new AtomicJsonStore<BindingGeneration>(this.pendingPath).write(value);
  }

  async selectDraft(value: BindingGeneration): Promise<void> {
    await mkdir(this.directory, {recursive: true});
    await new AtomicJsonStore<BindingGeneration>(this.draftPath).write(value);
  }

  async discardPending(): Promise<void> {
    await unlink(this.pendingPath).catch(() => undefined);
  }

  async quarantine(packageId: string, slot: string, reason: string): Promise<QuarantineRecord> {
    const records = await this.#quarantineList();
    const next = records.filter((item) => !(item.packageId === packageId && item.slot === slot));
    const record: QuarantineRecord = {packageId, slot, reason, timestamp: new Date().toISOString()};
    next.push(record);
    await new AtomicJsonStore<QuarantineRecord[]>(this.quarantinePath).write(next);
    return record;
  }

  async releaseQuarantine(packageId: string, slot: string): Promise<boolean> {
    const records = await this.#quarantineList();
    const next = records.filter((item) => !(item.packageId === packageId && item.slot === slot));
    if (next.length === records.length) return false;
    await new AtomicJsonStore<QuarantineRecord[]>(this.quarantinePath).write(next);
    return true;
  }

  async quarantined(): Promise<QuarantineRecord[]> {
    return this.#quarantineList();
  }

  async isQuarantined(packageId: string, slot: string): Promise<QuarantineRecord | undefined> {
    return (await this.#quarantineList()).find((item) => item.packageId === packageId && item.slot === slot);
  }

  async #quarantineList(): Promise<QuarantineRecord[]> {
    const result = await new AtomicJsonStore<QuarantineRecord[]>(this.quarantinePath).read([]);
    if (result.value.length === 0) return [];
    const validated = validateQuarantineRecords(result.value);
    return validated.ok ? validated.value! : [];
  }

  async previousGenerations(): Promise<BindingGeneration[]> {
    const store = new AtomicJsonStore<BindingGeneration[]>(this.historyPath);
    const result = await store.read([]);
    const candidates = result.value.filter((item): item is BindingGeneration => validateBindingGeneration(item).ok);
    return candidates.sort((left, right) => right.generation - left.generation).slice(0, HISTORY_LIMIT);
  }

  async commit(value: BindingGeneration): Promise<void> {
    await mkdir(this.directory, {recursive: true});
    const current = await this.committed();
    if (current.value) {
      await new AtomicJsonStore<BindingGeneration>(this.previousPath).write(current.value);
      const history = await this.previousGenerations();
      const next = [current.value, ...history.filter((item) => item.generation !== current.value!.generation)].slice(0, HISTORY_LIMIT);
      await new AtomicJsonStore<BindingGeneration[]>(this.historyPath).write(next);
    }
    await new AtomicJsonStore<BindingGeneration>(this.committedPath).write(value);
    await this.discardPending();
  }

  async committed(): Promise<BindingReadResult> { return this.#readGeneration(this.committedPath); }
  async pending(): Promise<BindingReadResult> { return this.#readGeneration(this.pendingPath); }
  async draft(): Promise<BindingReadResult> { return this.#readGeneration(this.draftPath); }
  async previous(): Promise<BindingReadResult> { return this.#readGeneration(this.previousPath); }

  // ADR 0002 section 1: a pending generation is never promoted. Recovery resumes from committed state and
  // only falls through when committed state is missing or unparseable.
  async recover(): Promise<BindingGeneration> {
    const committed = await this.committed();
    await this.discardPending();
    if (committed.value) return committed.value;
    const previous = await this.previous();
    if (previous.value) {
      await new AtomicJsonStore<BindingGeneration>(this.committedPath).write(previous.value);
      return previous.value;
    }
    return {generation: 0, bindings: {}};
  }

  async #readGeneration(path: string): Promise<BindingReadResult> {
    const read = await new AtomicJsonStore<BindingGeneration | null>(path).read(null);
    if (read.absent) return {absent: true};
    if (read.value === null) {
      if (read.backupPath === undefined) return {};
      return {backupPath: read.backupPath, diagnostic: read.diagnostic};
    }
    const validated = validateBindingGeneration(read.value);
    if (validated.ok) return {value: validated.value};
    const corrupt = await this.#markCorrupt(path, validated.issues.map((issue) => `${issue.path}: ${issue.code}`).join("; "));
    return corrupt;
  }

  async #markCorrupt(path: string, diagnostic: string): Promise<BindingReadResult> {
    const backupPath = `${path}.corrupt-${Date.now()}`;
    const moved = await rename(path, backupPath).then(() => true, () => false);
    return moved ? {backupPath, diagnostic} : {diagnostic};
  }
}
