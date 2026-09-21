import {copyFile, mkdir, readFile, rename, unlink, writeFile} from "node:fs/promises";
import {dirname} from "node:path";

export interface JsonReadResult<T> {
  value: T;
  backupPath?: string;
  diagnostic?: string;
}

export class AtomicJsonStore<T> {
  readonly path: string;
  constructor(path: string) { this.path = path; }

  async write(value: T): Promise<void> {
    await mkdir(dirname(this.path), {recursive: true});
    const temporary = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    const data = `${JSON.stringify(value, null, 2)}\n`;
    try {
      const handle = await import("node:fs/promises").then(({open}) => open(temporary, "w"));
      try { await handle.writeFile(data, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async read(fallback: T): Promise<JsonReadResult<T>> {
    try { return {value: JSON.parse(await readFile(this.path, "utf8")) as T}; }
    catch (error) {
      const backupPath = `${this.path}.corrupt-${Date.now()}`;
      let diagnostic = error instanceof Error ? error.message : String(error);
      try { await copyFile(this.path, backupPath); }
      catch (backupError) { diagnostic += `; backup failed: ${backupError instanceof Error ? backupError.message : String(backupError)}`; }
      return {value: fallback, backupPath, diagnostic};
    }
  }
}
