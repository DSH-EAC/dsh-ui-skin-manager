import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, readdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import test from "node:test";

import {
  BindingStore,
  ManagerError,
  PackageInstaller,
  ResolutionError,
  SkinManager,
  loadArtifact,
  sha256Hex,
  validateBindingGeneration,
  validateFaultEvent,
  type HostProfile,
  type SkinManifest,
  type SlotBinding,
  type SlotTransactionContext
} from "../src/index.ts";

const ENTRY = "export const mount = () => {};\n";
const STYLE = ".skin { color: rebeccapurple }\n";
const BASE = Date.parse("2026-09-24T08:00:00.000Z");

type Skin = {manifest: SkinManifest; files: Array<{path: string; data: string}>};

function skinOf(id: string, version: string, slots: string[], options: {dependencies?: Array<{id: string; range: string}>} = {}): Skin {
  const files = slots.flatMap((slot) => [
    {path: `regions/${slot}/entry.js`, data: `${ENTRY}/* ${id}@${version} */\n`},
    {path: `regions/${slot}/theme.css`, data: `${STYLE}/* ${id}@${version} */\n`}
  ]);
  const assets = files.map((file) => ({path: file.path, sha256: sha256Hex(new TextEncoder().encode(file.data))}));
  return {
    manifest: {
      apiVersion: "dsh.eac.ui-skin/v1",
      kind: "SkinPackage",
      metadata: {id, version, name: id, author: "publisher"},
      engines: {manager: "^1.0.0", hostProfile: "^0.3.0"},
      dependencies: options.dependencies ?? [],
      contributions: slots.map((slot) => ({
        id: `${slot}.main`,
        slot,
        entry: `regions/${slot}/entry.js`,
        assets: [`regions/${slot}/entry.js`],
        style: {entry: `regions/${slot}/theme.css`, assets: [`regions/${slot}/theme.css`]},
        requires: {capabilities: [], slotKind: [slot === "overlay" ? "overlay" : "region"], slotScope: [slot === "overlay" ? "document" : "window"]},
        lifecycle: {mount: "mount", health: "health", unmount: "unmount"}
      })),
      assets,
      integrity: Object.fromEntries(assets.map((asset) => [asset.path, asset.sha256]))
    },
    files
  };
}

function hostOf(fallbackDigest: string): HostProfile {
  return {
    id: "dsh-desktop-eac-ui-skin-profile",
    version: "0.3.0",
    regions: ["session", "overlay"],
    slots: [
      {id: "session", region: "session", kind: "region", scope: "window", propsSchema: {type: "object"}, mountContract: "dom-root@1", zIndexPolicy: {min: 0, max: 99}, capabilities: [], fallbackSkin: "system.default"},
      {id: "overlay", region: "overlay", kind: "overlay", scope: "document", propsSchema: {type: "object"}, mountContract: "portal@1", zIndexPolicy: {min: 100, max: 999}, capabilities: [], fallbackSkin: "system.default"}
    ],
    instanceKinds: ["popup"],
    zIndexPolicy: {session: {min: 0, max: 99}, overlay: {min: 100, max: 999}},
    capabilities: [],
    dshAdapters: [],
    fallbackSkin: {id: "system.default", version: "2.0.0", digest: fallbackDigest}
  };
}

async function artifact(root: string, skin: Skin): Promise<string> {
  const directory = join(root, skin.manifest.metadata.id, skin.manifest.metadata.version);
  for (const file of skin.files) {
    const absolute = join(directory, ...file.path.split("/"));
    await mkdir(dirname(absolute), {recursive: true});
    await writeFile(absolute, file.data, "utf8");
  }
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(skin.manifest, null, 2)}\n`, "utf8");
  return directory;
}

async function digestOf(artifactPath: string, probeRoot: string): Promise<string> {
  return (await new PackageInstaller(probeRoot).import(await loadArtifact(artifactPath))).installed.digest;
}

async function harness(extra: {transactionTimeoutMs?: number} = {}) {
  const base = await mkdtemp(join(tmpdir(), "skin-manager-"));
  const defaultDir = await artifact(join(base, "artifacts"), skinOf("system.default", "2.0.0", ["session", "overlay"]));
  const digest = await digestOf(defaultDir, join(base, "probe"));
  const profile = hostOf(digest);
  const stateDirectory = join(base, "state");
  const installRoot = join(base, "store");
  let elapsed = 0;
  const clock = () => new Date(BASE + elapsed);
  const options = {stateDirectory, installRoot, profile, managerVersion: "1.0.0", defaultPackage: {artifactPath: defaultDir, digest}, clock, ...extra};
  const manager = await SkinManager.open(options);
  return {
    base,
    digest,
    manager,
    bindings: new BindingStore(join(stateDirectory, "bindings")),
    committedPath: join(stateDirectory, "bindings", "committed.json"),
    logPath: join(stateDirectory, "logs", "skin-events.jsonl"),
    advance: (ms: number) => { elapsed += ms; },
    open: (overrides: Partial<typeof options> = {}) => SkinManager.open({...options, ...overrides, clock}),
    publish: async (skin: Skin, namespace = "artifacts") => artifact(join(base, namespace), skin),
    selectParty: async (id: string, slots: string[], ...selections: Array<[string, string]>) => {
      const directory = await artifact(join(base, "artifacts"), skinOf(id, "1.0.0", slots));
      await manager.importPackage(directory);
      await manager.select(selections.map(([slot, contribution]) => ({slot, packageId: id, version: "1.0.0", contribution})));
      return directory;
    }
  };
}

function tracer(fail: {slot: string; stage: string} = {slot: "none", stage: "none"}): {calls: string[]; contexts: (binding: SlotBinding) => SlotTransactionContext[]} {
  const calls: string[] = [];
  return {
    calls,
    contexts: (binding: SlotBinding) => {
      const context = (stage: string) => () => {
        calls.push(`${binding.slot}.${stage}`);
        if (binding.slot === fail.slot && stage === fail.stage) throw new Error(`${stage} refused ${binding.package.id}`);
      };
      return [{
        id: `${binding.slot}:${binding.package.id}`,
        prepare: context("prepare"),
        preload: context("preload"),
        activate: context("activate"),
        health: context("health"),
        commit: context("commit"),
        rollback: context("rollback"),
        disposeOld: context("disposeOld")
      }];
    }
  };
}

const refused = async (run: () => Promise<unknown>): Promise<string> => run().then(
  () => assert.fail("expected the call to be refused"),
  (error: unknown) => {
    assert.ok(error instanceof ManagerError || error instanceof ResolutionError, `expected a Manager/ResolutionError, got ${String(error)}`);
    return error.code;
  }
);

const logged = async (path: string): Promise<Record<string, unknown>[]> => (await readFile(path, "utf8")).split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);

test("open installs the digest-locked default and binds every slot it contributes to", async () => {
  const env = await harness();
  const status = env.manager.status();
  assert.deepEqual(Object.keys(status.bindings).sort(), ["overlay", "session"]);
  for (const binding of Object.values(status.bindings)) {
    assert.equal(binding.package.id, "system.default");
    assert.equal(binding.package.digest, env.digest);
    assert.equal(binding.state, "active");
  }
  assert.equal(status.installed.length, 1);
  assert.equal(status.installed[0]?.source, "embedded");
  assert.equal(validateBindingGeneration((await env.bindings.committed()).value).ok, true);
  assert.deepEqual(await readdir(join(env.base, "store", "packages")), ["system.default"]);
});

test("a default whose bytes do not match the locked digest is refused and nothing is bound", async () => {
  const env = await harness();
  const tampered = skinOf("system.default", "2.0.0", ["session", "overlay"]);
  const rewritten = `${ENTRY}/* rewritten */\n`;
  tampered.files[0]!.data = rewritten;
  const digest = sha256Hex(new TextEncoder().encode(rewritten));
  tampered.manifest.assets[0]!.sha256 = digest;
  tampered.manifest.integrity[tampered.files[0]!.path] = digest;
  const directory = await env.publish(tampered, "tampered");
  const error = await env.open({defaultPackage: {artifactPath: directory, digest: `sha256:${"a".repeat(64)}`}}).then(() => undefined, (cause: unknown) => cause);
  assert.ok(error instanceof ManagerError, `expected a ManagerError, got ${String(error)}`);
  assert.equal(error.code, "RECOVERY_DEFAULT_UNAVAILABLE");
  assert.match(error.message, /INTEGRITY_DIGEST_MISMATCH/);
});

test("select alone never switches a slot, apply publishes it and keeps the previous generation", async () => {
  const env = await harness();
  const before = env.manager.status().generation;
  const party = await env.publish(skinOf("party.session", "1.0.0", ["session"]));
  const imported = await env.manager.importPackage(party, {source: "local"});
  assert.equal(imported.installed.manifest.metadata.id, "party.session");
  assert.equal(imported.alreadyInstalled, false);
  assert.equal(imported.verifiedFiles, 2);
  assert.deepEqual(imported.resolution.map((item) => item.id), ["party.session"]);
  assert.equal(imported.fallback.id, "system.default");

  const draft = await env.manager.select([{slot: "session", packageId: "party.session", version: "1.0.0", contribution: "session.main"}]);
  assert.equal(draft.bindings.session?.package.id, "party.session");
  assert.equal(env.manager.status().bindings.session?.package.id, "system.default", "an unapplied choice must not reach the host");
  assert.equal((await env.bindings.draft()).value?.bindings.session?.package.id, "party.session", "an unapplied choice survives as a draft");
  assert.equal((await env.bindings.pending()).value, undefined, "select() may not open a transaction by itself");

  const trace = tracer();
  const outcome = await env.manager.apply(trace.contexts);
  assert.equal(outcome.slots.length, 1);
  assert.equal(outcome.slots[0]?.state, "active");
  assert.equal(env.manager.status().bindings.session?.package.id, "party.session");
  assert.equal(env.manager.status().generation > before, true);
  assert.equal((await env.bindings.pending()).value, undefined, "a finished transaction leaves no pending generation");
  assert.equal((await env.manager.draft())?.bindings.session?.package.id, "party.session");
  assert.equal((await env.manager.previousGenerations())[0]?.bindings.session?.package.id, "system.default", "the replaced generation stays recoverable");
  assert.equal((await env.manager.quarantined()).length, 0);
});

test("apply runs the ADR stage order per slot and persists what it commits", async () => {
  const env = await harness();
  await env.selectParty("party.both", ["session", "overlay"], ["session", "session.main"], ["overlay", "overlay.main"]);
  const trace = tracer();
  const outcome = await env.manager.apply(trace.contexts);
  assert.deepEqual(trace.calls, [
    "session.prepare", "session.preload", "session.activate", "session.health", "session.commit", "session.disposeOld",
    "overlay.prepare", "overlay.preload", "overlay.activate", "overlay.health", "overlay.commit", "overlay.disposeOld"
  ]);
  assert.deepEqual(outcome.slots.map((slot) => [slot.state, slot.slot]), [["active", "session"], ["active", "overlay"]]);
  const committed = (await env.bindings.committed()).value;
  assert.deepEqual(Object.keys(committed?.bindings ?? {}).sort(), ["overlay", "session"]);
  for (const binding of Object.values(committed?.bindings ?? {})) {
    assert.equal(binding.state, "active");
    assert.equal(binding.package.id, "party.both");
    assert.ok(binding.generation <= (committed?.generation ?? 0), "a binding may not claim a future generation");
  }
  assert.deepEqual((JSON.parse(await readFile(env.committedPath, "utf8")) as typeof committed)?.bindings, committed?.bindings);
});

test("a slot that fails health keeps its own binding while an unrelated slot is applied", async () => {
  const env = await harness();
  await env.selectParty("party.both", ["session", "overlay"], ["session", "session.main"], ["overlay", "overlay.main"]);
  const trace = tracer({slot: "overlay", stage: "health"});
  const outcome = await env.manager.apply(trace.contexts);
  assert.deepEqual(outcome.slots.map((slot) => slot.state), ["active", "failed"]);
  assert.equal(trace.calls.includes("overlay.commit"), false, "a slot that failed health must not commit");
  assert.equal(trace.calls.filter((call) => call === "overlay.rollback").length, 1);
  assert.equal(trace.calls.includes("overlay.disposeOld"), false, "post-commit cleanup only runs for a committed slot");

  const bindings = env.manager.status().bindings;
  assert.equal(bindings.session?.package.id, "party.both", "an unrelated failure may not roll back a healthy slot");
  assert.equal(bindings.overlay?.package.id, "system.default");
  const failed = outcome.slots[1];
  assert.ok(failed?.state === "failed");
  assert.equal(failed.fault.errorCode, "HEALTH_CHECK", "a health failure carries the HEALTH_ category the catalogue defines");
  assert.equal(failed.fault.lifecycleStage, "health");
  assert.equal(failed.fault.bindingState, "failed");
  assert.equal(failed.fault.packageId, "party.both");
  assert.equal(validateFaultEvent(failed.fault).ok, true);
  assert.match(failed.error.message, /health refused party.both/);
  assert.equal((await env.bindings.pending()).value, undefined);
});

test("a stage that hangs is reported under TIMEOUT_ rather than as a plain activation failure", async () => {
  const env = await harness({transactionTimeoutMs: 60});
  await env.selectParty("party.both", ["session", "overlay"], ["overlay", "overlay.main"]);
  const outcome = await env.manager.apply((binding) => [
    {id: `hang:${binding.slot}`, health: () => new Promise<void>(() => undefined)}
  ]);
  const failed = outcome.slots[0];
  assert.ok(failed?.state === "failed");
  assert.equal(failed.fault.errorCode, "TIMEOUT_HEALTH_CHECK");
  assert.equal(failed.fault.lifecycleStage, "health");
  assert.match(failed.error.message, /timed out after 60ms/);
  assert.equal(env.manager.status().bindings.overlay?.package.id, "system.default", "a hung health probe may not publish the candidate");
});

test("a stage that stops when its transaction is aborted cannot overtake the rollback", async () => {
  const env = await harness({transactionTimeoutMs: 40});
  await env.selectParty("party.session", ["session"], ["session", "session.main"]);
  const order: string[] = [];
  const outcome = await env.manager.apply((binding) => [{
    id: `late:${binding.slot}`,
    activate: (_binding, signal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => { order.push("activate stopped"); resolve(); });
    }),
    rollback: () => { order.push("rollback"); }
  }]);

  const failed = outcome.slots[0];
  assert.ok(failed?.state === "failed");
  assert.equal(failed.fault.errorCode, "TIMEOUT_MOUNT");
  assert.deepEqual(order, ["activate stopped", "rollback"], "the abandoned activation has to be seen to stop before the slot is handed back");
  assert.ok(!failed.error.message.includes("may land"), "a stage that observed its abort leaves nothing behind to warn about");
  assert.equal(env.manager.status().bindings.session?.package.id, "system.default");
});

test("a stage that ignores its abort is reported as an effect that may still land", async () => {
  const env = await harness({transactionTimeoutMs: 30});
  await env.selectParty("party.session", ["session"], ["session", "session.main"]);
  const outcome = await env.manager.apply((binding) => [
    {id: `deaf:${binding.slot}`, activate: () => new Promise<void>(() => undefined)}
  ]);

  const failed = outcome.slots[0];
  assert.ok(failed?.state === "failed");
  assert.equal(failed.fault.errorCode, "TIMEOUT_MOUNT");
  assert.match(failed.error.message, /may land on session after the restore/, "a hook that never stopped is the one rollback the manager cannot vouch for");
});

test("disposal residue quarantines the new package without un-publishing it", async () => {
  const env = await harness();
  await env.selectParty("party.session", ["session"], ["session", "session.main"]);
  const outcome = await env.manager.apply(tracer({slot: "session", stage: "disposeOld"}).contexts);
  assert.equal(outcome.slots[0]?.state, "active");
  assert.equal(env.manager.status().bindings.session?.package.id, "party.session");
  assert.deepEqual(await env.manager.quarantined(), [{packageId: "party.session", slot: "session", reason: "DISPOSE_RESIDUE"}]);
  const fault = env.manager.diagnostics.export().find((entry) => entry.errorCode === "DISPOSE_RESIDUE");
  assert.notEqual(fault, undefined);
  assert.equal(fault?.lifecycleStage, "dispose");
  assert.equal(fault?.recoveryAction, "disable-package");
  assert.equal(await refused(() => env.manager.select([{slot: "session", packageId: "party.session", version: "1.0.0", contribution: "session.main"}])), "DISPOSE_RESIDUE", "a quarantined package may not be switched back in");
  assert.equal(env.manager.status().bindings.session?.package.id, "party.session", "quarantining does not undo the generation that committed");
  assert.equal(await env.manager.enable("session", "party.session"), true);
  assert.deepEqual(await env.manager.quarantined(), []);
  assert.equal((await env.manager.select([{slot: "session", packageId: "party.session", version: "1.0.0", contribution: "session.main"}])).bindings.session?.package.id, "party.session", "an enabled package can be selected again");
  assert.equal(await refused(() => env.manager.disable("session", "party.session", "a human typed this")), "PERSISTENCE_QUARANTINE_REASON", "a quarantine reason must be a stable error code");
});

test("a quarantine survives a restart and still refuses the package that caused it", async () => {
  const env = await harness();
  await env.selectParty("party.session", ["session"], ["session", "session.main"]);
  await env.manager.apply(tracer({slot: "session", stage: "disposeOld"}).contexts);

  const reopened = await env.open();
  assert.deepEqual(await reopened.quarantined(), [{packageId: "party.session", slot: "session", reason: "DISPOSE_RESIDUE"}], "the record must be durable, not in-memory");
  assert.equal(await refused(() => reopened.select([{slot: "session", packageId: "party.session", version: "1.0.0", contribution: "session.main"}])), "DISPOSE_RESIDUE");
  assert.equal(reopened.diagnostics.dropped, 0, "a stored quarantine must not be rejected as unreadable on the next start");
  assert.ok((await readdir(join(env.base, "state", "bindings"))).includes("quarantine.json"));
});

test("select refuses a slot the profile does not offer and a package that is not installed", async () => {
  const env = await harness();
  const directory = await env.publish(skinOf("party.session", "1.0.0", ["session"]));
  await env.manager.importPackage(directory);
  assert.equal(await refused(() => env.manager.select([{slot: "chat-list", packageId: "party.session", version: "1.0.0", contribution: "session.main"}])), "COMPATIBILITY_SLOT");
  assert.equal(await refused(() => env.manager.select([{slot: "session", packageId: "party.session", version: "9.9.9", contribution: "session.main"}])), "DEPENDENCY_MISSING");
  assert.equal(await refused(() => env.manager.select([{slot: "overlay", packageId: "party.session", version: "1.0.0", contribution: "session.main"}])), "COMPATIBILITY_SLOT");
  assert.equal(env.manager.status().bindings.session?.package.id, "system.default");
  assert.deepEqual(env.manager.diagnostics.export().slice(-3).map((entry) => entry.errorCode), ["COMPATIBILITY_SLOT", "DEPENDENCY_MISSING", "COMPATIBILITY_SLOT"]);
  assert.equal(await env.manager.draft(), undefined, "a refused selection may not leave a draft behind");
});

test("a skin that installs but cannot resolve reports why instead of failing silently", async () => {
  const env = await harness();
  const broken = await env.publish(skinOf("party.needy", "1.0.0", ["session"], {dependencies: [{id: "party.missing", range: "^1.0.0"}]}));
  assert.equal(await refused(() => env.manager.importPackage(broken)), "DEPENDENCY_UNSATISFIED");
  assert.notEqual(env.manager.catalog.get("party.needy", "1.0.0"), undefined, "the verified bytes stay installed");
  const fault = env.manager.diagnostics.export().find((entry) => entry.errorCode === "DEPENDENCY_UNSATISFIED");
  assert.equal(fault?.severity, "warning");
  assert.equal(fault?.lifecycleStage, "resolve");
  assert.match(String(fault?.message), /party.missing/);
});

test("restart recovers the saved choice, seeds only unbound slots and discards a pending generation", async () => {
  const env = await harness();
  const party = await env.publish(skinOf("party.session", "1.0.0", ["session"]));
  await env.manager.importPackage(party);
  await env.manager.select([{slot: "session", packageId: "party.session", version: "1.0.0", contribution: "session.main"}]);
  await env.manager.apply(tracer().contexts);

  await env.bindings.stage({generation: 99, bindings: {session: {slot: "session", package: {id: "system.default", version: "2.0.0", digest: env.digest}, contribution: "session.main", generation: 99, state: "staged"}}});
  const reopened = await env.open();
  const bindings = reopened.status().bindings;
  assert.equal(bindings.session?.package.id, "party.session", "a restart may not overwrite the user's choice with the default");
  assert.equal(bindings.overlay?.package.id, "system.default");
  assert.equal((await reopened.bindings.pending()).value, undefined);
  const codes = reopened.diagnostics.export().map((entry) => entry.errorCode);
  assert.ok(codes.includes("RECOVERY_PENDING_DISCARDED"), codes.join(","));
  assert.equal(codes.includes("RECOVERY_FALLBACK_APPLIED"), false, "committed state was healthy, so no fallback was promoted");
  const again = await reopened.importPackage(party);
  assert.equal(again.alreadyInstalled, true);
  assert.equal(again.installed.digest, env.manager.catalog.get("party.session", "1.0.0")?.digest);
  assert.equal(reopened.status().installed.length, 2);
});

test("a corrupt committed generation is preserved for inspection and the previous-known-good is promoted", async () => {
  const env = await harness();
  await env.selectParty("party.first", ["session"], ["session", "session.main"]);
  await env.manager.apply(tracer().contexts);
  await env.selectParty("party.second", ["session"], ["session", "session.main"]);
  await env.manager.apply(tracer().contexts);
  assert.equal(env.manager.status().bindings.session?.package.id, "party.second");
  await writeFile(env.committedPath, "{not json", "utf8");

  const reopened = await env.open();
  const codes = reopened.diagnostics.export().map((entry) => entry.errorCode);
  assert.ok(codes.includes("PERSISTENCE_CORRUPT"), codes.join(","));
  assert.ok(codes.includes("RECOVERY_FALLBACK_APPLIED"), codes.join(","));
  assert.equal(reopened.status().bindings.session?.package.id, "party.first", "the newest previous-known-good generation is restored");
  assert.equal(reopened.status().bindings.overlay?.package.id, "system.default");
  assert.ok((await readdir(join(env.base, "state", "bindings"))).some((name) => name.includes(".corrupt-")));
  const committed = (await reopened.bindings.committed()).value;
  assert.equal(validateBindingGeneration(committed).ok, true);
  assert.equal(committed?.bindings.session?.package.id, "party.first");
});

test("rollback returns to the previous-known-good generation and a fresh state has none", async () => {
  const env = await harness();
  assert.equal(await refused(() => env.manager.rollback()), "RECOVERY_HISTORY_UNAVAILABLE");
  await env.selectParty("party.session", ["session"], ["session", "session.main"]);
  await env.manager.apply(tracer().contexts);
  const rolled = await env.manager.rollback();
  assert.equal(rolled.bindings.session?.package.id, "system.default");
  assert.equal(env.manager.status().bindings.session?.package.id, "system.default");
  assert.equal((await env.bindings.committed()).value?.bindings.session?.package.id, "system.default");
  assert.ok(env.manager.diagnostics.export().some((entry) => entry.errorCode === "RECOVERY_ROLLBACK_APPLIED"));
});

test("collectGarbage spares anything a binding or the host profile still references", async () => {
  const env = await harness();
  const used = await env.publish(skinOf("party.session", "1.0.0", ["session"]));
  const orphan = await env.publish(skinOf("party.orphan", "1.0.0", ["session"]));
  const imported = await env.manager.importPackage(used);
  const importedOrphan = await env.manager.importPackage(orphan);
  assert.equal(imported.installed.manifest.metadata.id, "party.session");
  await env.manager.select([{slot: "session", packageId: "party.session", version: "1.0.0", contribution: "session.main"}]);
  await env.manager.apply(tracer().contexts);
  await env.manager.rollback();

  const removed = await env.manager.collectGarbage();
  assert.deepEqual(removed.map((item) => item.manifest.metadata.id), ["party.orphan"]);
  assert.equal(env.manager.catalog.get("party.orphan", "1.0.0"), undefined);
  assert.equal(await readFile(join(importedOrphan.installed.versionPath, "regions/session/entry.js"), "utf8").then(() => true, () => false), false, "a collected package leaves the store");
  assert.notEqual(env.manager.catalog.get("party.session", "1.0.0"), undefined, "a package still in the history is not garbage");
  assert.notEqual(env.manager.catalog.get("system.default", "2.0.0"), undefined, "the embedded default is never collected");
  assert.equal(env.manager.status().bindings.session?.package.id, "system.default");
  await env.manager.collectGarbage();
  assert.equal(env.manager.catalog.get("party.session", "1.0.0") !== undefined, true);
});

test("force-enable keeps or restores the binding and persists the outcome", async () => {
  const env = await harness();
  const party = await env.publish(skinOf("party.session", "1.0.0", ["session"]));
  await env.manager.importPackage(party);
  let restored = 0;
  let committed = 0;
  const request = {
    slot: "session",
    target: "party.session",
    previous: "system.default",
    activate: () => undefined,
    restore: () => { restored += 1; },
    commit: async () => { committed += 1; }
  };
  const pending = await env.manager.beginForceEnable(request);
  assert.equal(pending.state, "pending");
  assert.equal(env.manager.forceEnable.active("session"), "party.session");
  assert.equal(await env.manager.keepForceEnable("session"), "kept");
  assert.equal(restored, 0);
  assert.equal(committed, 1);
  assert.equal((await env.bindings.committed()).value?.bindings.session?.package.id, "system.default", "keep() persists the manager's own bindings");

  env.advance(31_000);
  await env.manager.beginForceEnable({...request, commit: () => { throw new Error("the host refused the commit"); }});
  assert.equal(await env.manager.keepForceEnable("session"), "restored");
  assert.equal(restored, 1, "a commit that fails must restore the previous skin");

  env.advance(31_000);
  await env.manager.beginForceEnable(request);
  assert.equal(await env.manager.keepForceEnable("session"), "kept");
  assert.equal(restored, 1);

  env.advance(31_000);
  await env.manager.beginForceEnable(request);
  env.advance(31_000);
  await env.manager.expireForceEnable("session");
  assert.equal(restored, 2, "an unconfirmed window is closed by restoring");
  assert.equal(env.manager.forceEnable.active("session"), "system.default");
});

test("every fault the manager records reaches the structured log as a valid FaultEvent", async () => {
  const env = await harness();
  await refused(() => env.manager.select([{slot: "chat-list", packageId: "nope.nope", version: "1.0.0", contribution: "nope.main"}]));
  await env.selectParty("party.both", ["session", "overlay"], ["session", "session.main"], ["overlay", "overlay.main"]);
  await env.manager.apply(tracer({slot: "overlay", stage: "activate"}).contexts);
  await env.manager.disable("session", "party.both");
  await env.manager.flush();

  const exported = env.manager.diagnostics.export();
  assert.equal(exported.length, 3);
  const written = await logged(env.logPath);
  assert.equal(written.length, exported.length, "every retained fault is also exported");
  for (const [index, entry] of written.entries()) {
    assert.equal(validateFaultEvent(entry).ok, true, JSON.stringify(entry));
    assert.equal(entry.errorCode, exported[index]?.errorCode);
  }
  assert.deepEqual(written.map((entry) => entry.errorCode), ["COMPATIBILITY_SLOT", "ACTIVATE_MOUNT", "CAPABILITY_USER_DISABLED"]);
  assert.equal(env.manager.log.directory, join(env.base, "state", "logs"));
});

test("a fault code finer than the fourteen categories is persisted legally and still names its source", async () => {
  const env = await harness();
  env.manager.record("error", "ASSET_UNDECLARED", "session", "verify", "party.session declares regions/session/theme.css twice");
  await env.manager.flush();

  const written = await logged(env.logPath);
  const last = written.at(-1);
  assert.equal(last?.errorCode, "MANIFEST_ASSETS", "an operator greps the category, so the line has to carry one");
  assert.match(String(last?.message), /ASSET_UNDECLARED/, "and the finer code the caller actually threw must survive in the message");
  assert.equal(validateFaultEvent(last).ok, true);
  assert.equal(env.manager.diagnostics.dropped, 0, "a folded fault may not still be dropped for its code");
});

test("a host callback that throws before the transaction is not reported as a failed mount", async () => {
  const env = await harness();
  await env.selectParty("party.session", ["session"], ["session", "session.main"]);
  const outcome = await env.manager.apply(() => {
    throw new Error("the host could not build a transaction context");
  });

  const failed = outcome.slots[0];
  assert.ok(failed?.state === "failed");
  assert.equal(failed.fault.errorCode, "RUNTIME_FAILURE", "no stage ran, so ACTIVATE_* would point at a hook that never executed");
  assert.equal(failed.fault.lifecycleStage, "runtime");
  assert.equal(env.manager.status().bindings.session?.package.id, "system.default", "nothing was published");
});

test("a rollback that overlaps a suspended apply is not overwritten by its commit", async () => {
  const env = await harness();
  await env.selectParty("party.session", ["session"], ["session", "session.main"]);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const applying = env.manager.apply((binding) => [{id: `gate:${binding.slot}`, activate: async () => { entered(); await gate; }}]);
  await started;
  const rolling = env.manager.rollback();
  release();
  await Promise.all([applying, rolling]);

  const committed = (await env.bindings.committed()).value;
  assert.equal(committed?.bindings.session?.package.id, "system.default", "an explicit rollback is the later operation and has to win the file");
});

test("an install index entry pointing away from its own published path is dropped", async () => {
  const env = await harness();
  // The default is re-imported from its digest on every start whatever the index says, so the entry that proves
  // the gate has to be one nothing re-creates: a third-party package the host would otherwise mount.
  await env.manager.importPackage(await env.publish(skinOf("party.session", "1.0.0", ["session"])));
  const index = join(env.base, "state", "install-index.json");
  const record = JSON.parse(await readFile(index, "utf8")) as {packages: Record<string, {versionPath: string}>};
  const elsewhere = join(env.base, "elsewhere", "payload");
  for (const item of Object.values(record.packages)) item.versionPath = elsewhere;
  await writeFile(index, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  const reopened = await env.open();
  assert.deepEqual(reopened.status().installed.map((item) => item.id), ["system.default"], "a record whose path the store would never have written is not a package");
  assert.ok(reopened.diagnostics.export().some((entry) => entry.errorCode === "PERSISTENCE_INSTALL_INDEX"), "and dropping it has to be reported, not done quietly");
  assert.equal(await refused(() => reopened.select([{slot: "session", packageId: "party.session", version: "1.0.0", contribution: "session.main"}])), "DEPENDENCY_MISSING", "the host cannot be handed the redirected path to mount");
});
