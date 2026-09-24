import {createHash} from "node:crypto";

import type {SkinManifest, ValidationIssue} from "../contracts/models.ts";

export interface ArtifactFile {
  name: string;
  data: Uint8Array;
}

export interface InventoryResult {
  ok: boolean;
  issues: ValidationIssue[];
  files: ArtifactFile[];
}

// ADR 0001 section 1: manifest.json records the digest of every other archived payload file, so these
// envelope members are the only names a package may carry without an inventory entry.
export const ENVELOPE_FILES = new Set(["manifest.json", "LICENSE", "LICENSE.md", "NOTICE", "THIRD-PARTY-NOTICES.md"]);

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function toDigest(data: Uint8Array): string {
  return `sha256:${sha256Hex(data)}`;
}

function issue(issues: ValidationIssue[], code: string, path: string, message: string): void {
  issues.push({code, path, message});
}

export function verifyInventory(manifest: SkinManifest, files: ArtifactFile[]): InventoryResult {
  const issues: ValidationIssue[] = [];
  const declared = new Map<string, string>();
  manifest.assets.forEach((record, index) => {
    const path = `$.assets[${index}]`;
    if (ENVELOPE_FILES.has(record.path)) {
      issue(issues, "ASSET_ENVELOPE_RESERVED", `${path}.path`, "envelope metadata is not a payload asset");
      return;
    }
    if (declared.has(record.path)) issue(issues, "ASSET_DUPLICATE", `${path}.path`, "duplicates a normalized asset path");
    declared.set(record.path, record.sha256);
  });
  for (const [path, digest] of Object.entries(manifest.integrity)) {
    const expected = declared.get(path);
    if (expected === undefined) issue(issues, "INTEGRITY_UNDECLARED", `$.integrity.${path}`, "is not declared in assets");
    else if (expected !== digest) issue(issues, "INTEGRITY_MISMATCH", `$.integrity.${path}`, "asset and integrity digests differ");
  }
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.name)) issue(issues, "PATH_DUPLICATE", file.name, "two artifact members share one normalized name");
    seen.add(file.name);
    const expected = declared.get(file.name);
    if (expected === undefined) {
      if (!ENVELOPE_FILES.has(file.name)) issue(issues, "PATH_UNDECLARED", file.name, "is not declared in the asset inventory");
      continue;
    }
    const actual = sha256Hex(file.data);
    if (actual !== expected) issue(issues, "INTEGRITY_MISMATCH", file.name, `expected ${expected}, artifact carries ${actual}`);
  }
  for (const path of declared.keys()) {
    if (!seen.has(path)) issue(issues, "INTEGRITY_MISSING", path, "declared in the manifest but absent from the artifact");
  }
  return {ok: issues.length === 0, issues, files};
}
