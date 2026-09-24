// The end-to-end path a host integration takes: ingest an artifact, bind one slot, apply it, and read the
// recovered state back after a restart. Run it with `node examples/switch-slot.mjs` after `npm run build`; it
// asserts as it goes, so a README that drifts from the library fails here rather than in a host.
import assert from "node:assert/strict";
import {mkdir, mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";

import {SkinManager, sha256Hex} from "../dist/index.js";

const profile = {
  id: "dsh-desktop-eac-ui-skin-profile",
  version: "0.3.0",
  regions: ["session"],
  slots: [{
    id: "session", region: "session", kind: "region", scope: "window",
    propsSchema: {type: "object", additionalProperties: false}, mountContract: "dom-root@1",
    zIndexPolicy: {min: 0, max: 99}, capabilities: [], fallbackSkin: "system.default"
  }],
  instanceKinds: ["popup"],
  zIndexPolicy: {session: {min: 0, max: 99}},
  capabilities: [],
  dshAdapters: [],
  fallbackSkin: {id: "system.default", version: "2.0.0", digest: `sha256:${"0".repeat(64)}`}
};

async function writeArtifact(root, id, version) {
  const files = [
    {path: "regions/session/entry.js", data: `export const mount = () => {};\n/* ${id}@${version} */\n`},
    {path: "regions/session/theme.css", data: `.session { color: rebeccapurple }\n/* ${id}@${version} */\n`}
  ];
  const assets = files.map((file) => ({path: file.path, sha256: sha256Hex(new TextEncoder().encode(file.data))}));
  const manifest = {
    apiVersion: "dsh.eac.ui-skin/v1",
    kind: "SkinPackage",
    metadata: {id, version, name: id, author: "example"},
    engines: {manager: "^1.0.0", hostProfile: "^0.3.0"},
    dependencies: [],
    contributions: [{
      id: "session.main", slot: "session", entry: "regions/session/entry.js", assets: ["regions/session/entry.js"],
      style: {entry: "regions/session/theme.css", assets: ["regions/session/theme.css"]},
      requires: {capabilities: [], slotKind: ["region"], slotScope: ["window"]},
      lifecycle: {mount: "mount", health: "health", unmount: "unmount"}
    }],
    assets,
    integrity: Object.fromEntries(assets.map((asset) => [asset.path, asset.sha256]))
  };
  const directory = join(root, id, version);
  for (const file of files) {
    const absolute = join(directory, ...file.path.split("/"));
    await mkdir(dirname(absolute), {recursive: true});
    await writeFile(absolute, file.data, "utf8");
  }
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return directory;
}

const stage = await mkdtemp(join(tmpdir(), "dsh-skin-example-"));
const stateDirectory = join(stage, "state");
const installRoot = join(stage, "store");
const artifactPath = await writeArtifact(join(stage, "artifacts"), "example.midnight", "1.0.0");

const manager = await SkinManager.open({stateDirectory, installRoot, profile, managerVersion: "1.0.0"});
assert.deepEqual(manager.status().bindings, {}, "a host that has never switched a slot has no bindings");

const imported = await manager.importPackage(artifactPath);
console.log("installed", `${imported.installed.manifest.metadata.id}@${imported.installed.manifest.metadata.version}`, `as ${imported.installed.digest.slice(0, 18)}…`, `(${imported.verifiedFiles} files verified)`);

await manager.select([{slot: "session", packageId: "example.midnight", version: "1.0.0", contribution: "session.main"}]);
assert.equal(manager.status().bindings.session, undefined, "an unapplied choice must not reach the host");

const seen = [];
const outcome = await manager.apply((binding) => [{
  id: `dom-root@1:${binding.slot}`,
  prepare: () => seen.push("prepare"),
  preload: () => seen.push("preload"),
  activate: () => seen.push("activate"),
  health: () => seen.push("health"),
  commit: () => seen.push("commit"),
  disposeOld: () => seen.push("disposeOld")
}]);
assert.deepEqual(outcome.slots.map((slot) => slot.state), ["active"]);
assert.deepEqual(seen, ["prepare", "preload", "activate", "health", "commit", "disposeOld"]);
console.log("applied", JSON.stringify(outcome.slots.map((slot) => `${slot.slot} -> ${slot.binding.package.id}@${slot.binding.package.version}`)));

const reopened = await SkinManager.open({stateDirectory, installRoot, profile, managerVersion: "1.0.0"});
assert.equal(reopened.status().bindings.session?.package.id, "example.midnight", "a restart must recover the committed binding");
console.log("recovered", `generation ${reopened.status().generation}`, JSON.stringify(reopened.status().bindings.session?.package));

const faults = reopened.diagnostics.export();
assert.deepEqual(faults, [], "a clean run records no faults");
await reopened.flush();
console.log("ok");
