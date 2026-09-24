import {DIGEST_PATTERN} from "../contracts/constants.ts";
import {compareVersions, isValidVersion, parseVersion, satisfiesVersion, validateSkinManifest} from "../contracts/validation.ts";
import type {HostProfile, InstalledPackage, SkinManifest} from "../contracts/models.ts";

export class ResolutionError extends Error {
  readonly code: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ResolutionError";
    this.code = code;
  }
}

export interface Resolution {
  packages: InstalledPackage[];
  fallback: {id: string; version: string; digest: string};
}

function coordinate(id: string, version: string): string {
  return `${id}@${version}`;
}

function compareInstalled(left: InstalledPackage, right: InstalledPackage): number {
  const a = parseVersion(left.manifest.metadata.version);
  const b = parseVersion(right.manifest.metadata.version);
  if (!a || !b) return left.manifest.metadata.version.localeCompare(right.manifest.metadata.version);
  return compareVersions(a, b);
}

function candidatesFor(installed: InstalledPackage[], id: string, range: string): InstalledPackage[] {
  return installed
    .filter((item) => item.manifest.metadata.id === id && satisfiesVersion(item.manifest.metadata.version, range))
    .sort((left, right) => -compareInstalled(left, right));
}

export function resolvePackage(root: SkinManifest, installed: InstalledPackage[], options: {profile: HostProfile; managerVersion: string; hostVersion: string}): Resolution {
  const selected = new Map<string, InstalledPackage>();
  // A provider is claimed when it is first scheduled, not when it is dequeued, so a later constraint sees the
  // version that was already committed to and an unsatisfiable pair becomes a conflict instead of a silent pick.
  const chosen = new Map<string, InstalledPackage>();
  const rootItem = installed.find((item) => item.manifest.metadata.id === root.metadata.id && item.manifest.metadata.version === root.metadata.version);
  if (!rootItem) throw new ResolutionError("DEPENDENCY_MISSING", `${root.metadata.id}@${root.metadata.version} is not installed`);
  chosen.set(root.metadata.id, rootItem);
  const pending: SkinManifest[] = [root];
  while (pending.length > 0) {
    const current = pending.shift()!;
    const validation = validateSkinManifest(current, {profile: options.profile});
    if (!validation.ok) throw new ResolutionError("MANIFEST_INVALID", `${current.metadata.id}: ${validation.issues.map((issue) => issue.code).join(",")}`);
    if (!satisfiesVersion(options.managerVersion, current.engines.manager)) throw new ResolutionError("COMPATIBILITY_MANAGER", `${current.metadata.id} requires manager ${current.engines.manager}`);
    if (!satisfiesVersion(options.hostVersion, current.engines.hostProfile)) throw new ResolutionError("COMPATIBILITY_HOST_PROFILE", `${current.metadata.id} requires host profile ${current.engines.hostProfile}`);
    const key = coordinate(current.metadata.id, current.metadata.version);
    if (selected.has(key)) continue;
    const item = installed.find((candidate) => candidate.manifest.metadata.id === current.metadata.id && candidate.manifest.metadata.version === current.metadata.version);
    if (!item) throw new ResolutionError("DEPENDENCY_MISSING", key);
    selected.set(key, item);
    for (const dependency of current.dependencies ?? []) {
      // One slot binds one package, so a package id may only appear once in a resolution.
      const already = chosen.get(dependency.id);
      if (already) {
        if (!satisfiesVersion(already.manifest.metadata.version, dependency.range)) {
          throw new ResolutionError("DEPENDENCY_CONFLICT", `${dependency.id}@${already.manifest.metadata.version} cannot satisfy ${dependency.range} required by ${current.metadata.id}`);
        }
        continue;
      }
      const [match] = candidatesFor(installed, dependency.id, dependency.range);
      if (!match) throw new ResolutionError("DEPENDENCY_UNSATISFIED", `${dependency.id} ${dependency.range} required by ${current.metadata.id}`);
      chosen.set(dependency.id, match);
      pending.push(match.manifest);
    }
  }
  if (typeof options.profile.fallbackSkin?.id !== "string" || !isValidVersion(options.profile.fallbackSkin.version) || !DIGEST_PATTERN.test(options.profile.fallbackSkin.digest ?? "")) {
    throw new ResolutionError("RECOVERY_FALLBACK_UNDEFINED", "the host profile declares no digest-locked fallback skin");
  }
  return {
    packages: [...selected.values()]
      .map((item) => structuredClone(item))
      .sort((left, right) => coordinate(left.manifest.metadata.id, left.manifest.metadata.version).localeCompare(coordinate(right.manifest.metadata.id, right.manifest.metadata.version))),
    fallback: {...options.profile.fallbackSkin}
  };
}
