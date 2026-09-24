import assert from "node:assert/strict";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {PackageCatalog, validateInstalledPackage} from "../src/index.ts";
import type {InstalledPackage, SkinManifest} from "../src/index.ts";

const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;

function manifest(id: string, version = "1.0.0"): SkinManifest {
  return {
    apiVersion: "dsh.eac.ui-skin/v1",
    kind: "SkinPackage",
    metadata: {id, version, name: id, author: "author"},
    engines: {manager: "^1.0.0", hostProfile: "^0.3.0"},
    dependencies: [],
    contributions: [{id: "main", slot: "session", entry: "entry.js", assets: ["entry.js"], requires: {capabilities: [], slotKind: ["region"], slotScope: ["window"]}, lifecycle: {mount: "mount", health: "health", unmount: "unmount"}}],
    assets: [{path: "entry.js", sha256: "a".repeat(64)}],
    integrity: {"entry.js": "a".repeat(64)}
  };
}

const record = (id: string, letter = "a", overrides: Partial<InstalledPackage> = {}): InstalledPackage => ({
  manifest: manifest(id),
  versionPath: `/packages/${id}/1.0.0/${letter.repeat(64)}`,
  digest: digest(letter),
  source: "local",
  origin: `file:///tmp/${id}-1.0.0.zip`,
  ...overrides
});

async function store(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "skin-catalog-"));
  return join(dir, "install-index.json");
}

test("an install index survives a restart, which is what makes bindings resolvable", async () => {
  const path = await store();
  const catalog = new PackageCatalog({indexPath: path});
  await catalog.load();
  catalog.install(record("third.party.skin"));
  catalog.install(record("another.skin", "b"));
  assert.equal(await catalog.save(), true);
  assert.equal(await catalog.save(), false, "a clean catalog writes nothing again");

  const reopened = new PackageCatalog({indexPath: path});
  const result = await reopened.load();
  assert.deepEqual(result.issues, []);
  assert.equal(result.loaded, 2);
  assert.equal(reopened.get("third.party.skin", "1.0.0")?.digest, digest("a"));
  assert.equal(reopened.get("another.skin", "1.0.0")?.origin, "file:///tmp/another.skin-1.0.0.zip");
});

test("a corrupt or half-written index degrades to empty and reports why", async () => {
  const path = await store();
  await writeFile(path, "{\"packages\": {\"broken\"", "utf8");
  const catalog = new PackageCatalog({indexPath: path});
  const result = await catalog.load();
  assert.equal(catalog.size, 0);
  assert.ok(result.issues.some((issue) => issue.code === "PERSISTENCE_CORRUPT"));
});

test("an index entry that violates the contract is skipped instead of trusted", async () => {
  const path = await store();
  const good = record("good.skin");
  await writeFile(path, JSON.stringify({
    packages: {
      "good.skin@1.0.0": good,
      "bad.skin@1.0.0": {...record("bad.skin"), digest: "sha256:zz"},
      "other.skin@1.0.0": record("skewed.skin", "c")
    }
  }), "utf8");
  const catalog = new PackageCatalog({indexPath: path});
  const result = await catalog.load();
  assert.equal(catalog.size, 1);
  assert.equal(catalog.get("good.skin", "1.0.0")?.digest, good.digest);
  assert.ok(result.issues.some((issue) => issue.code === "PERSISTENCE_INSTALL_DIGEST"));
  assert.ok(result.issues.some((issue) => issue.code === "PERSISTENCE_COORDINATE_MISMATCH"));
  assert.equal(validateInstalledPackage(good).ok, true);
});

test("collection spares anything a generation references or that is embedded, and drops the rest", async () => {
  const path = await store();
  const zeroed = (id: string, letter: string, overrides: Partial<InstalledPackage> = {}): [string, InstalledPackage] => [
    `${id}@1.0.0`,
    {...record(id, letter, overrides), refCount: 0}
  ];
  await writeFile(path, JSON.stringify({
    packages: Object.fromEntries([
      zeroed("default.skin", "d", {source: "embedded", official: true}),
      zeroed("orphan.skin", "e"),
      zeroed("referenced.skin", "f")
    ])
  }), "utf8");
  const catalog = new PackageCatalog({indexPath: path});
  await catalog.load();
  const removed = catalog.collectGarbage(["referenced.skin@1.0.0"]);
  assert.deepEqual(removed.map((item) => item.manifest.metadata.id), ["orphan.skin"]);
  assert.deepEqual([catalog.get("default.skin", "1.0.0"), catalog.get("referenced.skin", "1.0.0")].map((item) => item?.manifest.metadata.id), ["default.skin", "referenced.skin"]);
  assert.equal(catalog.get("default.skin", "1.0.0")?.official, true, "official status comes from an embedded source, never from a manifest claim");
  assert.equal(await catalog.save(), true);
  const reopened = new PackageCatalog({indexPath: path});
  await reopened.load();
  assert.equal(reopened.get("orphan.skin", "1.0.0"), undefined, "collection is persisted, not just in-memory");
});

test("a memory-only catalog never claims to have persisted", async () => {
  const catalog = new PackageCatalog();
  catalog.install(record("third.party.skin"));
  assert.equal(await catalog.save(), false);
  assert.deepEqual((await catalog.load()).issues, []);
});
