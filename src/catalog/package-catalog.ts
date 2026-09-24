import {isValidVersion, validateInstalledPackage} from "../contracts/validation.ts";
import {storePath} from "../installer/package-installer.ts";
import {AtomicJsonStore} from "../persistence/atomic-json-store.ts";
import type {InstalledPackage, ValidationIssue} from "../contracts/models.ts";

export interface InstallIndex {
  packages: Record<string, InstalledPackage>;
}

export interface InstallQuery {
  id: string;
  version?: string;
  digest?: string;
}

export class CatalogError extends Error {
  readonly code: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "CatalogError";
    this.code = code;
  }
}

const coordinate = (id: string, version: string): string => `${id}@${version}`;

const EMPTY: InstallIndex = {packages: {}};

export class PackageCatalog {
  readonly index: AtomicJsonStore<InstallIndex> | undefined;
  readonly packagesRoot: string | undefined;
  #packages = new Map<string, InstalledPackage>();
  #dirty = false;

  constructor(options: {indexPath?: string; packagesRoot?: string} = {}) {
    this.index = options.indexPath === undefined ? undefined : new AtomicJsonStore<InstallIndex>(options.indexPath);
    this.packagesRoot = options.packagesRoot;
  }

  install(input: InstalledPackage): InstalledPackage {
    const key = coordinate(input.manifest.metadata.id, input.manifest.metadata.version);
    const previous = this.#packages.get(key);
    if (previous && previous.digest !== input.digest) {
      throw new CatalogError("INTEGRITY_COORDINATE_CONFLICT", `${key} is already installed as ${previous.digest}, ${input.digest} is a different artifact`);
    }
    // Installing is a registration, not a reference: a binding, a pending generation or the embedded default is what
    // holds a package, so an import may not silently make itself uncollectable. An explicit hold still counts, and
    // the higher of the recorded and incoming counts wins.
    const item: InstalledPackage = {
      ...input,
      refCount: Math.max(previous?.refCount ?? 0, input.refCount ?? 0),
      official: input.official === true && input.source === "embedded"
    };
    this.#packages.set(key, item);
    this.#dirty = true;
    return structuredClone(item);
  }

  get(id: string, version: string): InstalledPackage | undefined {
    const item = this.#packages.get(coordinate(id, version));
    return item ? structuredClone(item) : undefined;
  }

  find(query: InstallQuery): InstalledPackage[] {
    return this.list().filter((item) => item.manifest.metadata.id === query.id
      && (query.version === undefined || item.manifest.metadata.version === query.version)
      && (query.digest === undefined || item.digest === query.digest));
  }

  list(): InstalledPackage[] {
    return [...this.#packages.values()].sort((left, right) => {
      const ids = coordinate(left.manifest.metadata.id, left.manifest.metadata.version).localeCompare(coordinate(right.manifest.metadata.id, right.manifest.metadata.version));
      return ids !== 0 ? ids : left.digest.localeCompare(right.digest);
    }).map((item) => structuredClone(item));
  }

  get size(): number { return this.#packages.size; }

  // ADR 0002 section 1: an artifact referenced by active, pending, previous-known-good, or the bundled
  // default generation is never collectible, whatever its reference count claims.
  collectGarbage(referenced: Iterable<string>): InstalledPackage[] {
    const pinned = new Set(referenced);
    const removable = [...this.#packages.entries()].filter(([key, item]) => item.source !== "embedded" && !pinned.has(key) && (item.refCount ?? 0) <= 0);
    for (const [key] of removable) this.#packages.delete(key);
    if (removable.length > 0) this.#dirty = true;
    return removable.map(([, item]) => structuredClone(item));
  }

  uninstall(id: string, version: string): number {
    const key = coordinate(id, version);
    const item = this.#packages.get(key);
    if (!item) return 0;
    const count = Math.max(0, (item.refCount ?? 0) - 1);
    if (count === 0 && item.source !== "embedded") this.#packages.delete(key);
    else this.#packages.set(key, {...item, refCount: count});
    this.#dirty = true;
    return count;
  }

  async load(): Promise<{issues: ValidationIssue[]; loaded: number}> {
    if (!this.index) return {issues: [], loaded: this.#packages.size};
    const result = await this.index.read(EMPTY);
    const issues: ValidationIssue[] = [...result.diagnostic === undefined ? [] : [{code: "PERSISTENCE_CORRUPT", path: "$", message: result.diagnostic}]];
    const packages: Record<string, InstalledPackage> = result.value?.packages ?? {};
    let loaded = 0;
    for (const [key, item] of Object.entries(packages)) {
      const validation = validateInstalledPackage(item);
      const derived = validation.ok ? coordinate(item.manifest.metadata.id, item.manifest.metadata.version) : undefined;
      if (!validation.ok || derived !== key) {
        issues.push(...validation.ok ? [{code: "PERSISTENCE_COORDINATE_MISMATCH", path: key, message: `key must be ${derived ?? "the package coordinate"}`}] : validation.issues);
        continue;
      }
      // The record's own path has to be the path the store would have written it to. `versionPath` is the only
      // place a host looks to find the code it is about to import, so an index edited - or carried over from a
      // machine with a different root - to name somewhere else must be dropped, not trusted because it parsed.
      const published = this.#publishedPath(item);
      if (published !== undefined && published !== item.versionPath) {
        issues.push({code: "PERSISTENCE_INSTALL_PATH", path: key, message: "names a location outside the content-addressed path for its own id, version and digest"});
        continue;
      }
      this.#packages.set(key, item);
      loaded += 1;
    }
    this.#dirty = false;
    return {issues, loaded};
  }

  #publishedPath(item: InstalledPackage): string | undefined {
    if (this.packagesRoot === undefined) return undefined;
    const {id, version} = item.manifest.metadata;
    try {
      return storePath(this.packagesRoot, id, version, item.digest);
    } catch {
      // `validateInstalledPackage` already refused an illegal coordinate; a store path cannot be derived from
      // one, and the record has been reported rather than loaded.
      return undefined;
    }
  }

  async save(): Promise<boolean> {
    if (!this.index || !this.#dirty) return false;
    await this.index.write({packages: Object.fromEntries([...this.#packages.entries()].sort(([left], [right]) => left.localeCompare(right)))});
    this.#dirty = false;
    return true;
  }
}
