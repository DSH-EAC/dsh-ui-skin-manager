import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {validateSkinManifest} from "../src/index.ts";

const load = async (name: string): Promise<unknown> => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const profile = {
  id: "dsh-desktop-eac-ui-skin-profile", version: "0.3.2", regions: ["session"],
  slots: [{id: "session", region: "session", kind: "region", scope: "window", propsSchema: {}, mountContract: "dom-root@1", zIndexPolicy: {min: 0, max: 1}, capabilities: [], fallbackSkin: "system.default"}],
  instanceKinds: ["popup", "dialog", "floating-window"], zIndexPolicy: {session: {min: 0, max: 1}}, capabilities: [], dshAdapters: [],
  fallbackSkin: {id: "system.default", version: "2.0.0", digest: `sha256:${"a".repeat(64)}`}
};

test("rejects an incompatible host profile before activation", async () => {
  const result = validateSkinManifest(await load("incompatible/host-profile.json"), {profile});
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "COMPATIBILITY_HOST_PROFILE"));
});

test("rejects an unknown slot and missing capability before activation", async () => {
  const manifest = await load("valid/minimal-skin.json") as Record<string, any>;
  const unknown = structuredClone(manifest);
  unknown.contributions[0].slot = "unknown";
  const missing = structuredClone(manifest);
  missing.contributions[0].requires.capabilities = ["io.example.missing@^1.0.0"];
  assert.ok(validateSkinManifest(unknown, {profile}).issues.some((issue) => issue.code === "COMPATIBILITY_SLOT"));
  assert.ok(validateSkinManifest(missing, {profile}).issues.some((issue) => issue.code === "COMPATIBILITY_CAPABILITY"));
});
