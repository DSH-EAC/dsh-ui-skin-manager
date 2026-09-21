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

test("rejects duplicate asset and contribution coordinates", async () => {
  const manifest = await load("valid/minimal-skin.json");
  manifest.assets.push(structuredClone(manifest.assets[0]));
  manifest.contributions.push(structuredClone(manifest.contributions[0]));
  const issues = validateSkinManifest(manifest).issues;
  assert.ok(issues.some((issue) => issue.code === "ASSET_DUPLICATE"));
  assert.ok(issues.some((issue) => issue.code === "CONTRIBUTION_DUPLICATE"));
});
