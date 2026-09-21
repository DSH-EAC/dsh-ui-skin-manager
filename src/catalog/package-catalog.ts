import type {SkinManifest} from "../contracts/models.ts";

export interface InstalledPackage {
  manifest: SkinManifest;
  versionPath: string;
  digest: string;
  source: "local" | "embedded" | "remote";
  signature?: {algorithm: string; value: string; signer?: string};
  refCount?: number;
  official?: boolean;
}

export class PackageCatalog {
  #packages = new Map<string, InstalledPackage>();
  install(input: Omit<InstalledPackage, "refCount" | "official"> & {refCount?: number; official?: boolean}): InstalledPackage {
    const key = `${input.manifest.metadata.id}@${input.manifest.metadata.version}`;
    const previous = this.#packages.get(key);
    const item: InstalledPackage = {
      ...input,
      refCount: (previous?.refCount ?? input.refCount ?? 0) + 1,
      official: input.official === true && input.source === "embedded"
    };
    this.#packages.set(key, item);
    return {...item};
  }
  get(id: string, version: string): InstalledPackage | undefined { const item = this.#packages.get(`${id}@${version}`); return item && {...item}; }
  list(): InstalledPackage[] { return [...this.#packages.values()].map((item) => ({...item})); }
  uninstall(id: string, version: string): number {
    const key = `${id}@${version}`;
    const item = this.#packages.get(key);
    if (!item) return 0;
    const count = Math.max(0, (item.refCount ?? 0) - 1);
    if (count === 0 && item.source !== "embedded") this.#packages.delete(key);
    else this.#packages.set(key, {...item, refCount: count});
    return count;
  }
}
