import {lstat, readFile, readdir} from "node:fs/promises";
import {join} from "node:path";

import type {SkinManifest} from "../contracts/models.ts";
import {isSafePath, validateSkinManifest} from "../contracts/validation.ts";
import {PACK_MANIFEST, readContainer, stripPayloadRoot} from "./dshpack.ts";
import type {ContainerError, SkinPayload} from "./dshpack.ts";
import {sha256Hex, type ArtifactFile} from "./inventory.ts";
import {ARCHIVE_LIMITS, ArchiveError, isZip, readZip} from "./zip.ts";

export type ArtifactKind = "directory" | "zip" | "dshpack";

export interface LoadedArtifact {
  source: string;
  kind: ArtifactKind;
  files: ArtifactFile[];
  manifest: SkinManifest;
  archiveDigest?: string | undefined;
  container?: {id: string; version: string; root: string} | undefined;
}

export class ArtifactError extends Error {
  readonly code: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ArtifactError";
    this.code = code;
  }
}

const MANIFEST_FILE = "manifest.json";

const byName = (left: ArtifactFile, right: ArtifactFile): number => left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
const decode = (data: Uint8Array): unknown => JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(data));

function parseManifest(files: ArtifactFile[], source: string): SkinManifest {
  const entry = files.find((candidate) => candidate.name === MANIFEST_FILE);
  if (!entry) throw new ArtifactError("MANIFEST_NOT_FOUND", `${source} carries no ${MANIFEST_FILE}`);
  let value: unknown;
  try {
    value = decode(entry.data);
  } catch (error) {
    throw new ArtifactError("MANIFEST_PARSE", `${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const validation = validateSkinManifest(value);
  if (!validation.ok) throw new ArtifactError("MANIFEST_INVALID", `${source}: ${validation.issues.map((issue) => `${issue.path} ${issue.code}`).join("; ")}`);
  return validation.value!;
}

export interface ArtifactLimits {
  archiveBytes: number;
  fileBytes: number;
  totalBytes: number;
  entries: number;
}

async function readDirectory(root: string, budget: ArtifactLimits): Promise<ArtifactFile[]> {
  const files: ArtifactFile[] = [];
  let totalBytes = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      if (files.length >= budget.entries) throw new ArtifactError("ARTIFACT_TOO_LARGE", `${root} holds more than ${budget.entries} members`);
      const absolute = join(directory, entry.name);
      const name = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (!isSafePath(name)) throw new ArtifactError("PATH_UNSAFE", name);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) throw new ArtifactError("PATH_SYMLINK", `${name} is a symlink and cannot be installed`);
      if (stats.isDirectory()) {
        await walk(absolute, name);
        continue;
      }
      if (!stats.isFile()) throw new ArtifactError("PATH_SPECIAL_FILE", `${name} is neither a file nor a directory`);
      // The declared size is checked before the read for the same reason the archive is: a sparse file must not
      // be pulled into memory on the way to being refused.
      if (stats.size > budget.fileBytes) throw new ArtifactError("ARTIFACT_TOO_LARGE", `${name} is larger than ${budget.fileBytes} bytes`);
      totalBytes += stats.size;
      if (totalBytes > budget.totalBytes) throw new ArtifactError("ARTIFACT_TOO_LARGE", `${root} holds more than ${budget.totalBytes} bytes`);
      files.push({name, data: new Uint8Array(await readFile(absolute))});
    }
  };
  await walk(root, "");
  return files.sort(byName);
}

function readArchive(bytes: Uint8Array, source: string): ArtifactFile[] {
  let entries;
  try {
    entries = readZip(bytes);
  } catch (error) {
    if (error instanceof ArchiveError) throw new ArtifactError(error.code, `${source}: ${error.message}`);
    throw error;
  }
  return entries.filter((entry) => !entry.directory).map((entry) => ({name: entry.name, data: entry.data})).sort(byName);
}

function asContainer(entries: ArtifactFile[], source: string, archiveDigest: string): LoadedArtifact {
  const pack = entries.find((entry) => entry.name === PACK_MANIFEST);
  if (!pack) throw new ArtifactError("MANIFEST_DSHPACK_PACK_MISSING", `${source} declares no ${PACK_MANIFEST}`);
  let container;
  try {
    container = readContainer(decode(pack.data));
  } catch (error) {
    const code = (error as ContainerError).code ?? "MANIFEST_DSHPACK_PACK_INVALID";
    throw new ArtifactError(code, `${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const files = entries.flatMap((entry) => {
    const stripped = stripPayloadRoot(container.root, entry.name);
    return stripped === undefined || stripped.length === 0 ? [] : [{name: stripped, data: entry.data}];
  }).sort(byName);
  if (files.length === 0) throw new ArtifactError("COMPATIBILITY_DSHPACK_PAYLOAD_EMPTY", `${source} declares ${container.root} but it holds nothing`);
  return {
    source,
    kind: "dshpack",
    files,
    manifest: parseManifest(files, source),
    archiveDigest,
    container: {id: container.id, version: container.version, root: container.root}
  };
}

// The budget is the point of this function: `readZip` can only refuse an archive it has already been handed,
// so the size that decides whether to read at all has to be taken from the directory entry.
export async function loadArtifact(source: string, limits: Partial<ArtifactLimits> = {}): Promise<LoadedArtifact> {
  const budget: ArtifactLimits = {...ARCHIVE_LIMITS, ...limits};
  const stats = await lstat(source);
  if (stats.isSymbolicLink()) throw new ArtifactError("PATH_SYMLINK", `${source} is a symlink`);
  if (stats.isDirectory()) {
    const files = await readDirectory(source, budget);
    return {source, kind: "directory", files, manifest: parseManifest(files, source)};
  }
  if (!stats.isFile()) throw new ArtifactError("ARTIFACT_NOT_REGULAR", `${source} is neither a directory nor an archive`);
  if (stats.size > budget.archiveBytes) throw new ArtifactError("ARTIFACT_TOO_LARGE", `${source} is ${stats.size} bytes, over the ${budget.archiveBytes} an archive may have`);
  const bytes = new Uint8Array(await readFile(source));
  if (!isZip(bytes)) throw new ArtifactError("ARTIFACT_FORMAT_UNSUPPORTED", `${source} is not a zip, a .dshpack, or a directory`);
  const entries = readArchive(bytes, source);
  const archiveDigest = `sha256:${sha256Hex(bytes)}`;
  if (source.toLowerCase().endsWith(".dshpack")) return asContainer(entries, source, archiveDigest);
  return {source, kind: "zip", files: entries, manifest: parseManifest(entries, source), archiveDigest};
}
