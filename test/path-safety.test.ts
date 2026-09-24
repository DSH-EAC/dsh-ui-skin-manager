import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {validateSkinManifest} from "../src/index.ts";

const load = async (name: string): Promise<Record<string, any>> => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

test("rejects traversal and absolute package paths", async () => {
  const traversal = await load("invalid/path-traversal.json");
  assert.ok(validateSkinManifest(traversal).issues.some((issue) => issue.code === "PATH_UNSAFE"));
  traversal.contributions[0].entry = "/absolute.js";
  traversal.assets[0].path = "/absolute.js";
  traversal.integrity = {"/absolute.js": "a".repeat(64)};
  assert.ok(validateSkinManifest(traversal).issues.some((issue) => issue.code === "PATH_UNSAFE"));
});

test("rejects undeclared assets and digest disagreement", async () => {
  const manifest = await load("valid/minimal-skin.json");
  manifest.contributions[0].assets.push("regions/session/missing.png");
  assert.ok(validateSkinManifest(manifest).issues.some((issue) => issue.code === "ASSET_UNDECLARED"));
  const mismatch = await load("valid/minimal-skin.json");
  mismatch.integrity["regions/session/entry.js"] = "f".repeat(64);
  assert.ok(validateSkinManifest(mismatch).issues.some((issue) => issue.code === "INTEGRITY_MISMATCH"));
});

test("rejects traversal inside a contribution style inventory", async () => {
  const manifest = await load("valid/minimal-skin.json");
  manifest.contributions[0].style.assets = ["../../../../windows/styles.css"];
  const issues = validateSkinManifest(manifest).issues;
  assert.deepEqual(
    issues.filter((entry) => entry.code === "PATH_UNSAFE").map((entry) => entry.path),
    ["$.contributions[0].style.assets[0]"]
  );
});

test("reports the precise engines axis that is not a SemVer range", async () => {
  const manifest = await load("valid/minimal-skin.json");
  manifest.engines.hostProfile = "0.3";
  manifest.engines.dsh = "latest";
  manifest.engines.tauri = "^2.0.0";
  const issues = validateSkinManifest(manifest).issues.filter((entry) => entry.code === "COMPATIBILITY_RANGE");
  assert.deepEqual(issues.map((entry) => entry.path), ["$.engines.hostProfile", "$.engines.dsh", "$.engines.tauri"]);
});

test("a capability without an explicit range only requires the capability to exist", async () => {
  const manifest = await load("valid/minimal-skin.json");
  manifest.contributions[0].requires.capabilities = ["io.github.dsh-eac.ui.notifications"];
  const profile = {
    id: "dsh-desktop-eac-ui-skin-profile", version: "0.3.0", regions: ["session"],
    slots: [{id: "session", region: "session", kind: "region", scope: "window", propsSchema: {}, mountContract: "dom-root@1", zIndexPolicy: {min: 0, max: 99}, capabilities: ["io.github.dsh-eac.ui.notifications@1.0.0"], fallbackSkin: "system.default"}],
    instanceKinds: [], zIndexPolicy: {session: {min: 0, max: 99}},
    capabilities: [{id: "io.github.dsh-eac.ui.notifications", version: "1.0.0"}], dshAdapters: [],
    fallbackSkin: {id: "system.default", version: "2.0.0", digest: `sha256:${"c".repeat(64)}`}
  };
  assert.deepEqual(validateSkinManifest(manifest, {profile}).issues, []);
});

test("rejects a malformed capability requirement rather than passing it", async () => {
  const manifest = await load("valid/minimal-skin.json");
  const profile = {
    id: "dsh-desktop-eac-ui-skin-profile", version: "0.3.0", regions: ["session"],
    slots: [{id: "session", region: "session", kind: "region", scope: "window", propsSchema: {}, mountContract: "dom-root@1", zIndexPolicy: {min: 0, max: 99}, capabilities: [], fallbackSkin: "system.default"}],
    instanceKinds: [], zIndexPolicy: {}, capabilities: [{id: "io.github.dsh-eac.ui.notifications", version: "1.0.0"}], dshAdapters: [],
    fallbackSkin: {id: "system.default", version: "2.0.0", digest: `sha256:${"c".repeat(64)}`}
  };
  for (const requirement of ["io.github.dsh-eac.ui.notifications@^", "@^1.0.0", "Mixed.Case@^1.0.0"]) {
    manifest.contributions[0].requires.capabilities = [requirement];
    const issues = validateSkinManifest(manifest, {profile}).issues.filter((entry) => entry.code === "COMPATIBILITY_CAPABILITY");
    assert.equal(issues.length, 1, `${requirement} must be rejected`);
  }
  manifest.contributions[0].requires.capabilities = ["io.github.dsh-eac.ui.notifications@>=2.0.0"];
  assert.match(validateSkinManifest(manifest, {profile}).issues[0]?.message ?? "", /host offers 1\.0\.0/);
});

test("rejects duplicate asset and contribution coordinates", async () => {
  const manifest = await load("valid/minimal-skin.json");
  manifest.assets.push(structuredClone(manifest.assets[0]));
  manifest.contributions.push(structuredClone(manifest.contributions[0]));
  const issues = validateSkinManifest(manifest).issues;
  assert.ok(issues.some((issue) => issue.code === "ASSET_DUPLICATE"));
  assert.ok(issues.some((issue) => issue.code === "CONTRIBUTION_DUPLICATE"));
});
