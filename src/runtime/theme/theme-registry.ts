export interface ThemeOwner {
  slot: string;
  generation: number;
}

interface ThemeEntry {
  value: unknown;
  owner: ThemeOwner;
  disposed: boolean;
}

export class ThemeRegistry {
  #entries = new Map<string, ThemeEntry>();

  register(name: string, value: unknown, owner: ThemeOwner): {isCurrent(): boolean; dispose(): Promise<void>} {
    if (this.#entries.has(name)) throw new Error(`THEME_DUPLICATE: ${name}`);
    return this.#install(name, value, owner);
  }

  override(name: string, value: unknown, owner: ThemeOwner): {isCurrent(): boolean; dispose(): Promise<void>} {
    const previous = this.#entries.get(name);
    if (previous) previous.disposed = true;
    return this.#install(name, value, owner);
  }

  get(name: string): unknown {
    return this.#entries.get(name)?.value;
  }

  #install(name: string, value: unknown, owner: ThemeOwner) {
    const entry: ThemeEntry = {value, owner, disposed: false};
    this.#entries.set(name, entry);
    let report: Promise<void> | undefined;
    return {
      isCurrent: () => this.#entries.get(name) === entry && !entry.disposed,
      dispose: () => report ??= Promise.resolve().then(() => {
        if (this.#entries.get(name) === entry) this.#entries.delete(name);
        entry.disposed = true;
      })
    };
  }
}
