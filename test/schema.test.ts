import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {validateDisposeReport, validateFaultEvent, validateHostProfile, validateSkinManifest, validateSlotBinding, validateSlotContribution} from "../src/index.ts";

const fixture = async (path: string): Promise<unknown> => JSON.parse(await readFile(new URL(`./fixtures/${path}`, import.meta.url), "utf8"));
const validProfile = {
  id: "dsh-desktop-eac-ui-skin-profile", version: "0.3.0", regions: ["session"],
  slots: [{id: "session", region: "session", kind: "region", scope: "window", propsSchema: {}, mountContract: "dom-root@1", zIndexPolicy: {min: 0, max: 99}, capabilities: ["io.github.dsh-eac.ui.notifications@1.0.0"], fallbackSkin: "system.default"}],
  instanceKinds: ["popup", "dialog", "floating-window"], zIndexPolicy: {session: {min: 0, max: 99}},
  capabilities: [{id: "io.github.dsh-eac.ui.notifications", version: "1.0.0"}], dshAdapters: [],
  fallbackSkin: {id: "system.default", version: "2.0.0", digest: `sha256:${"c".repeat(64)}`}
};

test("accepts all six frozen contract models", async () => {
  const manifest = await fixture("valid/minimal-skin.json");
  assert.equal(validateSkinManifest(manifest, {profile: validProfile}).ok, true);
  assert.equal(validateSlotContribution((manifest as {contributions: unknown[]}).contributions[0]).ok, true);
  assert.equal(validateHostProfile(validProfile).ok, true);
  assert.equal(validateSlotBinding({slot: "session", package: {id: "system.default", version: "2.0.0", digest: `sha256:${"a".repeat(64)}`}, contribution: "session.main", generation: 1, state: "active"}).ok, true);
  assert.equal(validateFaultEvent({timestamp: "2026-09-20T00:00:00.000Z", severity: "error", errorCode: "ACTIVATE_FAILED", message: "fixture", correlationId: "fixture-1", generation: 1, regionOrSlot: "session", lifecycleStage: "activate", source: "third-party", recoverable: true, recoveryAction: "restore-default", bindingState: "failed"}).ok, true);
  assert.equal(validateDisposeReport({generation: 1, slot: "session", attempted: 1, released: 1, remaining: [], errors: [], timedOut: false, completedAt: "2026-09-20T00:00:00.000Z"}).ok, true);
});

test("rejects wrong identity type version dependency and digest", async () => {
  const valid = await fixture("valid/minimal-skin.json") as Record<string, any>;
  const cases = [
    {...valid, apiVersion: "dsh.eac.ui-skin/v2"},
    {...valid, kind: "Plugin"},
    {...valid, metadata: {...valid.metadata, id: "Upper Case"}},
    {...valid, metadata: {...valid.metadata, version: "v2"}},
    {...valid, dependencies: [{id: "system.default", range: "not-a-range"}]},
    {...valid, assets: [{path: "entry.js", sha256: "xyz"}], integrity: {"entry.js": "xyz"}}
  ];
  for (const candidate of cases) assert.equal(validateSkinManifest(candidate).ok, false);
});
