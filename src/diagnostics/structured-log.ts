import {appendFile, mkdir, readFile, readdir, rename, stat, unlink} from "node:fs/promises";
import {join} from "node:path";

import {LOG_POLICY} from "../contracts/constants.ts";
import type {FaultEvent} from "../contracts/models.ts";
import {validateFaultEvent} from "../contracts/validation.ts";
import {redact, redactDetail} from "./redaction.ts";

export interface StructuredLogOptions {
  directory: string;
  basename?: string;
  maxFileBytes?: number;
  retentionDays?: number;
  now?: () => Date;
}

export interface LogWriteResult {
  written: boolean;
  path?: string;
  rotated?: boolean;
  rejected?: string;
}

const DEFAULT_BASENAME = "skin-events";

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function line(entry: Record<string, unknown>): string {
  return `${JSON.stringify(entry)}\n`;
}

// ADR 0002 section 6: JSONL, 16 MiB rotation, 30-day retention, and redaction applied before persistence.
export class StructuredLog {
  readonly directory: string;
  readonly basename: string;
  readonly maxFileBytes: number;
  readonly retentionDays: number;
  readonly now: () => Date;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: StructuredLogOptions) {
    this.directory = options.directory;
    this.basename = options.basename ?? DEFAULT_BASENAME;
    this.maxFileBytes = options.maxFileBytes ?? LOG_POLICY.maxFileBytes;
    this.retentionDays = options.retentionDays ?? LOG_POLICY.retentionDays;
    this.now = options.now ?? (() => new Date());
    if (!Number.isFinite(this.maxFileBytes) || this.maxFileBytes <= 0) throw new RangeError("maxFileBytes must be positive");
    if (!Number.isFinite(this.retentionDays) || this.retentionDays <= 0) throw new RangeError("retentionDays must be positive");
  }

  get activePath(): string {
    return join(this.directory, `${this.basename}.jsonl`);
  }

  async write(entry: FaultEvent | Record<string, unknown>): Promise<LogWriteResult> {
    const record = this.#prepare(entry);
    if (record === undefined) {
      return {written: false, rejected: "the entry does not satisfy the FaultEvent contract"};
    }
    let rotated = false;
    let failure: unknown;
    await this.#enqueue(async () => {
      await mkdir(this.directory, {recursive: true});
      if (await this.#size(this.activePath) >= this.maxFileBytes) {
        await rename(this.activePath, join(this.directory, await this.#archiveName())).catch(() => undefined);
        rotated = true;
      }
      try {
        await appendFile(this.activePath, line(record), "utf8");
      } catch (error) {
        failure = error;
      }
    });
    if (failure !== undefined) {
      return {written: false, rejected: failure instanceof Error ? failure.message : String(failure)};
    }
    return {written: true, path: this.activePath, rotated};
  }

  async flush(): Promise<void> {
    await this.#queue;
  }

  // Rotation may also happen at start or on a day boundary; retention is an age floor, never shortened by it.
  async rotate(): Promise<boolean> {
    if ((await this.#size(this.activePath)) === 0) return false;
    await this.#enqueue(async () => {
      await mkdir(this.directory, {recursive: true});
      await rename(this.activePath, join(this.directory, await this.#archiveName()));
    });
    return true;
  }

  async purge(): Promise<number> {
    const cutoff = this.now().getTime() - this.retentionDays * 24 * 60 * 60 * 1000;
    const names = await readdir(this.directory).catch(() => [] as string[]);
    let removed = 0;
    for (const name of names.filter((candidate) => candidate !== `${this.basename}.jsonl` && candidate.startsWith(`${this.basename}-`) && candidate.endsWith(".jsonl"))) {
      const path = join(this.directory, name);
      const info = await stat(path).catch(() => undefined);
      if (info === undefined || info.mtimeMs > cutoff) continue;
      if (await unlink(path).then(() => true, () => false)) removed += 1;
    }
    return removed;
  }

  async read(count: number): Promise<Record<string, unknown>[]> {
    const names = (await readdir(this.directory).catch(() => [] as string[])).filter((name) => name.startsWith(`${this.basename}-`) && name.endsWith(".jsonl")).sort();
    const files = [...names.map((name) => join(this.directory, name)), this.activePath];
    const entries: Record<string, unknown>[] = [];
    for (const path of files) {
      const text = await readFile(path, "utf8").catch(() => "");
      for (const raw of text.split("\n")) {
        if (raw.trim().length === 0) continue;
        try {
          entries.push(JSON.parse(raw) as Record<string, unknown>);
        } catch {
          /* a partially written line is dropped rather than blocking export */
        }
      }
    }
    return entries.slice(Math.max(0, entries.length - count));
  }

  #prepare(entry: FaultEvent | Record<string, unknown>): Record<string, unknown> | undefined {
    const candidate = entry as Record<string, unknown>;
    const record: Record<string, unknown> = {...candidate, timestamp: typeof candidate.timestamp === "string" ? candidate.timestamp : this.now().toISOString()};
    if (typeof record.message === "string") record.message = redact(record.message);
    if (record.detail !== undefined && record.detail !== null) record.detail = redactDetail(record.detail as Record<string, unknown>);
    // An entry carrying an errorCode claims to be a FaultEvent, so it is held to that contract; anything else is
    // an ordinary operational line and is written without inventing fields for it.
    if (record.errorCode !== undefined && !validateFaultEvent(record).ok) return undefined;
    return record;
  }

  async #size(path: string): Promise<number> {
    return (await stat(path).catch(() => undefined))?.size ?? 0;
  }

  // The stamp only has millisecond resolution, so two rotations in one tick would rename onto the same archive and
  // discard the older one. A collision is numbered instead, and the number is padded so lexical order stays
  // chronological for a reader that sorts the archive names.
  async #archiveName(): Promise<string> {
    const base = `${this.basename}-${stamp(this.now())}`;
    for (let attempt = 0; ; attempt += 1) {
      const name = `${base}-${String(attempt).padStart(3, "0")}.jsonl`;
      if ((await stat(join(this.directory, name)).catch(() => undefined)) === undefined) return name;
    }
  }

  #enqueue(task: () => Promise<void>): Promise<void> {
    this.#queue = this.#queue.then(task, task);
    return this.#queue;
  }
}
