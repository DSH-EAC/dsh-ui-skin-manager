import {copyFile, mkdir, open, readFile, rename, unlink} from "node:fs/promises";
import {dirname} from "node:path";

export interface JsonReadResult<T> {
  value: T;
  absent?: boolean | undefined;
  backupPath?: string | undefined;
  diagnostic?: string | undefined;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class AtomicJsonStore<T> {
  readonly path: string;
  constructor(path: string) { this.path = path; }

  async write(value: T): Promise<void> {
    await mkdir(dirname(this.path), {recursive: true});
    const temporary = `${this.path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = `${JSON.stringify(value, null, 2)}\n`;
    try {
      const handle = await open(temporary, "w");
      try {
        await handle.writeFile(data, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
      await this.#syncDirectory();
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async read(fallback: T): Promise<JsonReadResult<T>> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {value: fallback, absent: true};
      return {value: fallback, ...await this.#backup(error)};
    }
    try {
      return {value: JSON.parse(raw) as T};
    } catch (error) {
      return {value: fallback, ...await this.#backup(error)};
    }
  }

  // A rename is only durable once its parent directory entry is flushed. Platforms that refuse directory
  // handles (Windows) keep the rename itself, which is already atomic there.
  async #syncDirectory(): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(dirname(this.path), "r");
      await handle.sync();
    } catch {
      return;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #backup(cause: unknown): Promise<{backupPath: string; diagnostic: string}> {
    const backupPath = `${this.path}.corrupt-${Date.now()}`;
    const detail = message(cause);
    try {
      await copyFile(this.path, backupPath);
      return {backupPath, diagnostic: detail};
    } catch (backupError) {
      return {backupPath, diagnostic: `${detail}; backup failed: ${message(backupError)}`};
    }
  }
}
