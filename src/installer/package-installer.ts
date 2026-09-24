import {lstat, mkdir, mkdtemp, rename, rm, stat, writeFile} from "node:fs/promises";
import {dirname, isAbsolute, join, relative} from "node:path";

import type {InstalledPackage, SkinManifest, ValidationIssue} from "../contracts/models.ts";
import {isPackageId, isSafePath, isValidVersion, validateSkinManifest} from "../contracts/validation.ts";
import type {ArtifactFile, InventoryResult} from "../artifact/inventory.ts";
import {sha256Hex, verifyInventory} from "../artifact/inventory.ts";
import {loadArtifact} from "../artifact/load.ts";
import type {LoadedArtifact} from "../artifact/load.ts";

export interface ImportOptions {
  signature?: {algorithm: string; value: string; signer?: string};
  expectedDigest?: string;
  source?: "local" | "embedded" | "remote";
}

export interface ImportResult {
  installed: InstalledPackage;
  alreadyInstalled: boolean;
  verifiedFiles: number;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MANIFEST_FILE = "manifest.json";

export class InstallError extends Error {
  readonly code: string;
  readonly issues: ValidationIssue[];

  constructor(code: string, detail: string, issues: ValidationIssue[] = []) {
    super(`${code}: ${detail}`);
    this.name = "InstallError";
    this.code = code;
    this.issues = issues;
  }
}

function fail(code: string, detail: string, issues: ValidationIssue[] = []): never {
  throw new InstallError(code, detail, issues);
}

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

// This is the only definition of where a published package lives, so anything that has to trust a stored path
// can ask for it instead of memorising the layout: a path that did not come from here is not a store path.
export function storePath(root: string, id: string, version: string, digest: string): string {
  if (!isPackageId(id)) fail("MANIFEST_ID", `${JSON.stringify(id)} is not a package identifier`);
  if (!isValidVersion(version)) fail("MANIFEST_VERSION", `${id}@${JSON.stringify(version)} is not a SemVer version`);
  if (!DIGEST.test(digest)) fail("INTEGRITY_DIGEST_INVALID", `${id}@${version} carries ${JSON.stringify(digest)}`);
  return join(root, "packages", id, version, digest.slice("sha256:".length));
}

export class PackageInstaller {
  readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root)) fail("PATH_ABSOLUTE_REQUIRED", `the install root must be absolute, received ${root}`);
    this.root = root;
  }

  // Every path inside the store is built here, so this is the one place a coordinate has to be proven
  // path-safe. Without it remove("../../victim", …) resolves outside the install root.
  versionPath(id: string, version: string, digest: string): string {
    return storePath(this.root, id, version, digest);
  }

  async import(artifact: LoadedArtifact, options: ImportOptions = {}): Promise<ImportResult> {
    const manifest = artifact.manifest;
    const validation = validateSkinManifest(manifest);
    if (!validation.ok) fail("MANIFEST_INVALID", `${manifest.metadata.id}@${manifest.metadata.version}`, validation.issues);
    const payload = artifact.files.filter((entry) => entry.name !== MANIFEST_FILE);
    const folded = new Map<string, string>();
    for (const file of artifact.files) {
      if (!isSafePath(file.name)) fail("PATH_UNSAFE", file.name);
      const key = file.name.toLowerCase();
      const previous = folded.get(key);
      if (previous !== undefined && previous !== file.name) {
        fail("PATH_DUPLICATE_CASE_INSENSITIVE", `${previous} and ${file.name} are one file on the host filesystem`);
      }
      folded.set(key, file.name);
    }
    const inventory = verifyInventory(manifest, payload);
    if (!inventory.ok) fail("INTEGRITY_MISMATCH", `${manifest.metadata.id}@${manifest.metadata.version} failed its inventory gate`, inventory.issues);

    const digest = `sha256:${sha256Hex(contentDigestInput(payload))}`;
    if (options.expectedDigest !== undefined) {
      if (!DIGEST.test(options.expectedDigest)) fail("INTEGRITY_DIGEST_INVALID", `the locked digest ${options.expectedDigest} is not a sha256 digest`);
      if (options.expectedDigest !== digest) {
        fail("INTEGRITY_DIGEST_MISMATCH", `${manifest.metadata.id}@${manifest.metadata.version} carries ${digest}, the caller locked ${options.expectedDigest}`);
      }
    }
    const source: InstalledPackage["source"] = options.source ?? "local";
    const target = this.versionPath(manifest.metadata.id, manifest.metadata.version, digest);
    const installed: InstalledPackage = {
      manifest,
      versionPath: target,
      digest,
      source,
      origin: artifact.source,
      archiveDigest: artifact.archiveDigest,
      ...(artifact.container === undefined ? {} : {container: artifact.container}),
      ...(options.signature === undefined ? {} : {signature: options.signature})
    };
    if (await exists(target)) {
      await this.#verifyPublished(target, manifest, digest);
      return {installed, alreadyInstalled: true, verifiedFiles: payload.length};
    }

    await mkdir(dirname(target), {recursive: true});
    // Created exclusively under a random name: a predictable staging path would let anything that can write
    // into the store pre-place a symlink there and have the staged bytes land outside the install root.
    const staging = await mkdtemp(`${target}.staging-`);
    try {
      for (const file of [...payload, ...artifact.files.filter((entry) => entry.name === MANIFEST_FILE)]) {
        await this.#write(staging, file);
      }
      if (await exists(target)) {
        await rm(staging, {recursive: true, force: true});
        await this.#verifyPublished(target, manifest, digest);
        return {installed, alreadyInstalled: true, verifiedFiles: payload.length};
      }
      await rename(staging, target);
    } catch (error) {
      await rm(staging, {recursive: true, force: true}).catch(() => undefined);
      if (error instanceof InstallError) throw error;
      fail("PERSISTENCE_WRITE_FAILED", `${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {installed, alreadyInstalled: false, verifiedFiles: payload.length};
  }

  // A published directory *is* the artifact's identity, so a re-import may not trust it merely because it
  // exists. Without this, bytes edited or removed after install keep loading under the digest that names them.
  async #verifyPublished(target: string, manifest: SkinManifest, digest: string): Promise<void> {
    const coordinate = `${manifest.metadata.id}@${manifest.metadata.version}`;
    let published: LoadedArtifact;
    try {
      published = await loadArtifact(target);
    } catch (error) {
      fail("INTEGRITY_MISMATCH", `${coordinate} is no longer a readable package in the store: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (published.manifest.metadata.id !== manifest.metadata.id || published.manifest.metadata.version !== manifest.metadata.version) {
      fail("INTEGRITY_MISMATCH", `${target} declares ${published.manifest.metadata.id}@${published.manifest.metadata.version}, not ${coordinate}`);
    }
    const payload = published.files.filter((entry) => entry.name !== MANIFEST_FILE);
    if (`sha256:${sha256Hex(contentDigestInput(payload))}` !== digest) {
      fail("INTEGRITY_MISMATCH", `${coordinate} no longer matches the ${digest} that names its published bytes`);
    }
  }

  async remove(id: string, version: string, digest: string): Promise<boolean> {
    const target = this.versionPath(id, version, digest);
    if (!(await exists(target))) return false;
    await rm(target, {recursive: true, force: true});
    return true;
  }

  async #write(staging: string, file: ArtifactFile): Promise<void> {
    const absolute = join(staging, ...file.name.split("/"));
    const escaped = relative(staging, absolute);
    if (escaped.startsWith("..") || isAbsolute(escaped)) fail("PATH_TRAVERSAL", file.name);
    const parent = dirname(absolute);
    await mkdir(parent, {recursive: true});
    for (const step of this.#chain(staging, parent)) {
      if ((await lstat(step).catch(() => undefined))?.isSymbolicLink()) fail("PATH_SYMLINK", `${step} escaped the staging directory`);
    }
    await writeFile(absolute, file.data, {flag: "wx"});
  }

  #chain(staging: string, directory: string): string[] {
    const steps: string[] = [];
    let cursor = directory;
    while (cursor.length >= staging.length && cursor.startsWith(staging)) {
      steps.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    return steps.reverse();
  }
}

// Content addressing must not depend on envelope order, so member names and lengths are folded in sorted order.
function contentDigestInput(files: ArtifactFile[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts = [...files].sort((left, right) => (left.name < right.name ? -1 : 1)).map((file) => {
    const header = encoder.encode(`${file.name}\0${file.data.byteLength}\0`);
    const merged = new Uint8Array(header.byteLength + file.data.byteLength);
    merged.set(header, 0);
    merged.set(file.data, header.byteLength);
    return merged;
  });
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}
