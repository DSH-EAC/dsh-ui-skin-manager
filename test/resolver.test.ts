import assert from "node:assert/strict";
import test from "node:test";

import {ResolutionError, resolvePackage} from "../src/index.ts";
import type {HostProfile, InstalledPackage, SkinManifest} from "../src/index.ts";

const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;

function manifest(id: string, version = "1.0.0", overrides: Partial<SkinManifest> = {}): SkinManifest {
  return {
    apiVersion: "dsh.eac.ui-skin/v1",
    kind: "SkinPackage",
    metadata: {id, version, name: id, author: "author"},
    engines: {manager: "^1.0.0", hostProfile: "^0.3.0"},
    dependencies: [],
    contributions: [{id: "main", slot: "session", entry: "entry.js", assets: ["entry.js"], requires: {capabilities: [], slotKind: ["region"], slotScope: ["window"]}, lifecycle: {mount: "mount", health: "health", unmount: "unmount"}}],
    assets: [{path: "entry.js", sha256: "a".repeat(64)}],
    integrity: {"entry.js": "a".repeat(64)},
    ...overrides
  };
}

const profile: HostProfile = {
  id: "dsh-desktop-eac-ui-skin-profile",
  version: "0.3.0",
  regions: ["session"],
  slots: [{id: "session", region: "session", kind: "region", scope: "window", propsSchema: {}, mountContract: "dom-root@1", zIndexPolicy: {min: 0, max: 99}, capabilities: [], fallbackSkin: "system.default"}],
  instanceKinds: [],
  zIndexPolicy: {session: {min: 0, max: 99}},
  capabilities: [],
  dshAdapters: [],
  fallbackSkin: {id: "system.default", version: "2.0.0", digest: digest("d")}
};

const installed = (id: string, version = "1.0.0", letter = "a"): InstalledPackage => ({
  manifest: manifest(id, version),
  versionPath: `/packages/${id}/${version}/${letter.repeat(64)}`,
  digest: digest(letter),
  source: "local",
  origin: `file:///tmp/${id}-${version}.zip`,
  refCount: 1,
  official: false
});

const installedOf = (source: SkinManifest, letter = "a"): InstalledPackage => ({
  ...installed(source.metadata.id, source.metadata.version, letter),
  manifest: source
});

const resolve = (root: SkinManifest, list: InstalledPackage[], options: {managerVersion?: string; hostVersion?: string; profile?: HostProfile} = {}) =>
  resolvePackage(root, list, {profile: options.profile ?? profile, managerVersion: options.managerVersion ?? "1.0.0", hostVersion: options.hostVersion ?? "0.3.0"});

const code = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ResolutionError, `expected a ResolutionError, got ${String(error)}`);
    return error.code;
  }
  assert.fail("expected resolution to fail");
};

test("resolution walks dependencies and reports the profile's digest-locked fallback", () => {
  const root = manifest("root.skin", "1.0.0", {dependencies: [{id: "dependency.skin", range: "^1.0.0"}]});
  const resolved = resolve(root, [installedOf(root), installed("dependency.skin", "1.4.2", "b")]);
  assert.deepEqual(resolved.packages.map((item) => `${item.manifest.metadata.id}@${item.manifest.metadata.version}`), ["dependency.skin@1.4.2", "root.skin@1.0.0"]);
  assert.deepEqual(resolved.fallback, profile.fallbackSkin, "the fallback must come from the host profile, not a hard-coded coordinate");
  assert.notEqual(resolved.packages[0], installed("dependency.skin"), "resolution hands out copies, not live catalog records");
});

test("the highest satisfying version wins and a two-digit version does not lose", () => {
  const root = manifest("root.skin", "1.0.0", {dependencies: [{id: "lib.skin", range: ">=1.0.0 <2.0.0"}]});
  const list = [installedOf(root), installed("lib.skin", "1.9.0"), installed("lib.skin", "1.10.0", "c"), installed("lib.skin", "2.0.0", "d")];
  const resolved = resolve(root, list);
  assert.deepEqual(resolved.packages.map((item) => `${item.manifest.metadata.id}@${item.manifest.metadata.version}`), ["lib.skin@1.10.0", "root.skin@1.0.0"]);
});

test("an unsatisfiable or conflicting dependency is named, not swallowed", () => {
  const missing = manifest("root.skin", "1.0.0", {dependencies: [{id: "absent.skin", range: "^1.0.0"}]});
  assert.equal(code(() => resolve(missing, [installedOf(missing)])), "DEPENDENCY_UNSATISFIED");

  const a = manifest("a.skin", "1.0.0", {dependencies: [{id: "shared.skin", range: ">=1.0.0 <2.0.0"}]});
  const b = manifest("b.skin", "1.0.0", {dependencies: [{id: "shared.skin", range: "1.0.0"}]});
  const root = manifest("root.skin", "1.0.0", {dependencies: [{id: "a.skin", range: "^1.0.0"}, {id: "b.skin", range: "^1.0.0"}]});
  const list = [installedOf(root), installedOf(a), installedOf(b), installed("shared.skin", "1.0.0"), installed("shared.skin", "1.5.0")];
  assert.equal(code(() => resolve(root, list)), "DEPENDENCY_CONFLICT");

  const compatible = manifest("root.skin", "1.0.0", {dependencies: [{id: "a.skin", range: "^1.0.0"}, {id: "b.skin", range: "^1.0.0"}]});
  const bOk = manifest("b.skin", "1.0.0", {dependencies: [{id: "shared.skin", range: ">=1.0.0 <2.0.0"}]});
  const ok = resolve(compatible, [installedOf(compatible), installedOf(a), installedOf(bOk), installed("shared.skin", "1.0.0"), installed("shared.skin", "1.5.0")]);
  assert.deepEqual(ok.packages.map((item) => item.manifest.metadata.id), ["a.skin", "b.skin", "root.skin", "shared.skin"]);
});

test("a dependency cycle terminates instead of looping", () => {
  const a = manifest("a.skin", "1.0.0", {dependencies: [{id: "b.skin", range: "^1.0.0"}]});
  const b = manifest("b.skin", "1.0.0", {dependencies: [{id: "a.skin", range: "^1.0.0"}]});
  const resolved = resolve(a, [installedOf(a), installedOf(b)]);
  assert.deepEqual(resolved.packages.map((item) => item.manifest.metadata.id), ["a.skin", "b.skin"]);
});

test("a cycle back to the root enforces the root's own version", () => {
  const root = manifest("root.skin", "2.0.0", {dependencies: [{id: "helper.skin", range: "^1.0.0"}]});
  const helper = manifest("helper.skin", "1.0.0", {dependencies: [{id: "root.skin", range: "^1.0.0"}]});
  assert.equal(code(() => resolve(root, [installedOf(root), installedOf(helper)])), "DEPENDENCY_CONFLICT");
});

test("resolution refuses a package that is not installed", () => {
  assert.equal(code(() => resolve(manifest("ghost.skin"), [])), "DEPENDENCY_MISSING");
});

test("manager, host profile, and manifest gates all run before activation", () => {
  assert.equal(code(() => resolve(manifest("root.skin", "1.0.0", {engines: {manager: "^2.0.0", hostProfile: "^0.3.0"}}), [installed("root.skin")])), "COMPATIBILITY_MANAGER");
  assert.equal(code(() => resolve(manifest("root.skin"), [installed("root.skin")], {hostVersion: "0.4.0"})), "COMPATIBILITY_HOST_PROFILE");
  const broken = manifest("root.skin");
  broken.contributions = [];
  assert.equal(code(() => resolve(broken, [installed("root.skin")])), "MANIFEST_INVALID");
});

test("a host profile without a digest-locked fallback cannot resolve", () => {
  assert.equal(code(() => resolve(manifest("root.skin"), [installed("root.skin")], {profile: {...profile, fallbackSkin: {id: "system.default", version: "2.0", digest: "nope"}}})), "RECOVERY_FALLBACK_UNDEFINED");
});
