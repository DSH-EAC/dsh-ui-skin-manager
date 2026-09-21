import {copyFile, mkdir, readdir, rename} from "node:fs/promises";
import {join} from "node:path";
import {createHash} from "node:crypto";
import type {SkinManifest} from "../contracts/models.ts";
import {validateSkinManifest} from "../contracts/validation.ts";
import type {PackageCatalog, InstalledPackage} from "../catalog/package-catalog.ts";

export interface ImportResult {installed: InstalledPackage; official: false}

export class PackageInstaller {
  private readonly catalog: PackageCatalog;
  private readonly root: string;
  constructor(catalog: PackageCatalog, root: string) { this.catalog = catalog; this.root = root; }
  async importManifest(manifest: SkinManifest, sourcePath: string, digest: string, signature?: {algorithm: string; value: string; signer?: string}): Promise<ImportResult> {
    const validation = validateSkinManifest(manifest);
    if (!validation.ok) throw new Error(`MANIFEST_INVALID: ${validation.issues.map((item) => item.code).join(",")}`);
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("INTEGRITY_DIGEST_INVALID");
    const target = join(this.root, manifest.metadata.id, manifest.metadata.version, digest.slice(7));
    await mkdir(target, {recursive: true});
    const installed = this.catalog.install({manifest, versionPath: target, digest, source: "local", ...(signature ? {signature} : {}), official: false});
    return {installed, official: false};
  }

  static sha256(data: Uint8Array): string { return createHash("sha256").update(data).digest("hex"); }
}
