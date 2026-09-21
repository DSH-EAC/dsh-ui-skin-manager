import {satisfiesVersion, validateSkinManifest} from "../contracts/validation.ts";
import type {HostProfile, SkinManifest} from "../contracts/models.ts";
import type {InstalledPackage} from "../catalog/package-catalog.ts";

export interface Resolution {
  packages: InstalledPackage[];
  fallback: {id: "system.default"; version: "2.0.0"};
}

export function resolvePackage(root: SkinManifest, installed: InstalledPackage[], options: {profile: HostProfile; managerVersion: string; hostVersion: string}): Resolution {
  const packages = new Map<string, InstalledPackage>();
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift()!;
    const validation = validateSkinManifest(current, {profile: options.profile});
    if (!validation.ok) throw new Error(`MANIFEST_INVALID: ${validation.issues.map((item) => item.code).join(",")}`);
    if (!satisfiesVersion(options.managerVersion, current.engines.manager) || !satisfiesVersion(options.hostVersion, current.engines.hostProfile)) throw new Error(`COMPATIBILITY_FAILED: ${current.metadata.id}`);
    const key = `${current.metadata.id}@${current.metadata.version}`;
    if (!packages.has(key)) {
      const item = installed.find((candidate) => candidate.manifest.metadata.id === current.metadata.id && candidate.manifest.metadata.version === current.metadata.version);
      if (!item) {
        if (current.metadata.id !== root.metadata.id) throw new Error(`DEPENDENCY_MISSING: ${current.metadata.id}`);
        packages.set(key, {manifest: current, versionPath: "embedded://uninstalled", digest: "sha256:" + "0".repeat(64), source: "local", refCount: 0, official: false});
      } else { packages.set(key, item); }
      for (const dependency of current.dependencies ?? []) {
        const candidate = installed.find((item) => item.manifest.metadata.id === dependency.id && satisfiesVersion(item.manifest.metadata.version, dependency.range));
        if (!candidate) throw new Error(`DEPENDENCY_UNSATISFIED: ${dependency.id}`);
        pending.push(candidate.manifest);
      }
    }
  }
  const rootItem = installed.find((item) => item.manifest.metadata.id === root.metadata.id && item.manifest.metadata.version === root.metadata.version);
  if (rootItem) packages.set(`${root.metadata.id}@${root.metadata.version}`, rootItem);
  return {packages: [...packages.values()].sort((left, right) => left.manifest.metadata.id.localeCompare(right.manifest.metadata.id)), fallback: {id: "system.default", version: "2.0.0"}};
}
