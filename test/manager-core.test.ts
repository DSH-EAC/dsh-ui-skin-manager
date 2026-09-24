import assert from "node:assert/strict";
import {mkdtemp, readFile, readdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {PackageCatalog} from "../src/catalog/package-catalog.ts";
import {AtomicJsonStore} from "../src/persistence/atomic-json-store.ts";
import {BindingStore} from "../src/bindings/binding-store.ts";
import {resolvePackage} from "../src/resolver/package-resolver.ts";
import {DiagnosticStore} from "../src/diagnostics/diagnostic-store.ts";
import type {HostProfile, SkinManifest} from "../src/index.ts";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const manifest = (id = "third.party.skin", version = "1.0.0"): SkinManifest => ({
  apiVersion: "dsh.eac.ui-skin/v1", kind: "SkinPackage",
  metadata: {id, version, name: id, author: "author"}, engines: {manager: "^1.0.0", hostProfile: "^0.3.0"}, dependencies: [],
  contributions: [{id: "main", slot: "session", entry: "entry.js", assets: ["entry.js"], requires: {capabilities: [], slotKind: ["region"], slotScope: ["window"]}, lifecycle: {mount: "mount", health: "health", unmount: "unmount"}}],
  assets: [{path: "entry.js", sha256: "a".repeat(64)}], integrity: {"entry.js": "a".repeat(64)}
});
const profile = {id: "dsh-desktop-eac-ui-skin-profile", version: "0.3.0", regions: ["session"], slots: [{id: "session", region: "session", kind: "region", scope: "window", propsSchema: {}, mountContract: "dom-root@1", zIndexPolicy: {min: 0, max: 99}, capabilities: [], fallbackSkin: "system.default"}], instanceKinds: [], zIndexPolicy: {session: {min: 0, max: 99}}, capabilities: [], dshAdapters: [], fallbackSkin: {id: "system.default", version: "2.0.0", digest: digest("d")}} satisfies HostProfile;

test("a missing state file is absent, not corrupt evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skin-manager-"));
  const store = new BindingStore(dir);
  const committed = await store.committed();
  assert.equal(committed.value, undefined);
  assert.equal(committed.absent, true);
  assert.equal(committed.diagnostic, undefined);
  assert.equal(committed.backupPath, undefined);
  assert.deepEqual((await readdir(dir)).filter((name) => name.includes("corrupt")), []);
  const recovered = await store.recover();
  assert.deepEqual(recovered, {generation: 0, bindings: {}});
});

test("state that parses but violates the contract is quarantined as corrupt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skin-manager-"));
  const store = new BindingStore(dir);
  await store.commit({generation: 6, bindings: {}});
  await store.commit({generation: 7, bindings: {}});
  await writeFile(store.committedPath, `${JSON.stringify({generation: 7, bindings: {session: {slot: "overlay", package: {id: "a.b", version: "1.0.0", digest: digest("a")}, contribution: "main", generation: 4, state: "active"}}}, null, 2)}\n`, "utf8");
  const read = await store.committed();
  assert.equal(read.value, undefined);
  assert.match(read.diagnostic ?? "", /PERSISTENCE_BINDING_SLOT_KEY/);
  assert.ok(read.backupPath);
  assert.match(await readFile(read.backupPath!, "utf8"), /overlay/);
  assert.equal((await store.recover()).generation, 6, "previous-known-good is promoted instead of a corrupt commit");
});

test("catalog deduplicates installs and keeps unsigned packages third-party", () => {
  const catalog = new PackageCatalog();
  const item = {manifest: manifest(), versionPath: "/packages/third.party.skin/1.0.0/a", digest: digest("a"), source: "local" as const};
  assert.equal(catalog.install(item).refCount, 1);
  assert.equal(catalog.install(item).refCount, 2);
  assert.equal(catalog.get("third.party.skin", "1.0.0")?.official, false);
  assert.equal(catalog.uninstall("third.party.skin", "1.0.0"), 1);
});

test("resolver resolves dependencies and always exposes system.default fallback", () => {
  const root = manifest("root.skin");
  root.dependencies = [{id: "dependency.skin", range: "^1.0.0"}];
  const dependency = {manifest: manifest("dependency.skin"), versionPath: "/packages/dependency.skin/1.0.0/a", digest: digest("b"), source: "local" as const, refCount: 1, official: false};
  const resolved = resolvePackage(root, [dependency], {profile, managerVersion: "1.0.0", hostVersion: "0.3.0"});
  assert.deepEqual(resolved.packages.map((item) => item.manifest.metadata.id), ["dependency.skin", "root.skin"]);
  assert.equal(resolved.fallback.id, "system.default");
});

test("binding recovery discards pending and preserves committed evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skin-manager-"));
  const store = new BindingStore(dir);
  await store.commit({generation: 1, bindings: {session: {slot: "session", package: {id: "system.default", version: "2.0.0", digest: digest("d")}, contribution: "main", generation: 1, state: "active"}}});
  await store.stage({generation: 2, bindings: {}});
  const recovered = await store.recover();
  assert.equal(recovered.generation, 1);
  assert.equal((await store.pending()).value, undefined);
  assert.equal((await store.committed()).value?.generation, 1);
});

test("binding store retains two known-good generations and supports selected draft", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skin-manager-"));
  const store = new BindingStore(dir);
  await store.selectDraft({generation: 1, bindings: {}});
  assert.equal((await store.draft()).value?.generation, 1);
  for (const generation of [1, 2, 3, 4]) await store.commit({generation, bindings: {}});
  assert.deepEqual((await store.previousGenerations()).map((item) => item.generation), [3, 2]);
});

test("quarantine is isolated by package and slot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skin-manager-"));
  const store = new BindingStore(dir);
  await store.quarantine("third.party.skin", "session", "HEALTH_FAILED");
  assert.equal((await store.isQuarantined("third.party.skin", "session"))?.reason, "HEALTH_FAILED");
  assert.equal(await store.isQuarantined("third.party.skin", "overlay"), undefined);
});

test("corrupt JSON is backed up and exported as a diagnostic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skin-manager-"));
  const path = join(dir, "state.json");
  const store = new AtomicJsonStore<{ok: boolean}>(path);
  await store.write({ok: true});
  await (await import("node:fs/promises")).writeFile(path, "{broken", "utf8");
  const result = await store.read({ok: false});
  assert.equal(result.value.ok, false);
  assert.ok(result.backupPath);
  assert.equal((await readFile(result.backupPath!, "utf8")), "{broken");
  const diagnostics = new DiagnosticStore();
  diagnostics.record({errorCode: "PERSISTENCE_CORRUPT", regionOrSlot: "session", lifecycleStage: "recovery", message: result.diagnostic!});
  assert.equal(diagnostics.export()[0]?.errorCode, "PERSISTENCE_CORRUPT");
});
