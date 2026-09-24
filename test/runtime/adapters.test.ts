import assert from "node:assert/strict";
import test from "node:test";

import {
  DshClientRuntimeAdapter,
  HostSlotRuntimeAdapter,
  RuntimeSupervisor,
  ThemeRegistry
} from "../../src/index.ts";
import type {HostProfile, SlotDescriptor} from "../../src/index.ts";

const descriptor: SlotDescriptor = {
  id: "session",
  region: "session",
  kind: "region",
  scope: "window",
  propsSchema: {},
  mountContract: "dom-root@1",
  zIndexPolicy: {min: 0, max: 99},
  capabilities: ["io.github.dsh-eac.ui.notifications@1"],
  fallbackSkin: "system.default"
};

const profile: HostProfile = {
  id: "dsh-desktop-eac-ui-skin-profile",
  version: "0.3.0",
  regions: ["session"],
  slots: [descriptor],
  instanceKinds: ["popup", "dialog", "floating-window"],
  zIndexPolicy: {session: {min: 0, max: 99}},
  capabilities: [{id: "io.github.dsh-eac.ui.notifications@1", version: "1.0.0"}],
  dshAdapters: [],
  fallbackSkin: {id: "system.default", version: "2.0.0", digest: `sha256:${"d".repeat(64)}`}
};

test("mounts a typed host slot and releases style, slot, listener, and timer effects", async () => {
  const events: string[] = [];
  const host = {
    mount: (slot: string) => ({slot, appendStyle: () => {events.push("style");}, removeStyle: () => {events.push("remove-style");}}),
    showError: () => {},
    supportsCapability: (capability: string) => capability === descriptor.capabilities[0]
  };
  const adapter = new HostSlotRuntimeAdapter({profile, host, timeoutMs: 100});
  const mounted = await adapter.mount({slot: "session", kind: "region", scope: "window", capabilities: descriptor.capabilities, generation: 1, component: ({context}) => {
    context.ledger.register("listener", () => {events.push("listener");});
    context.ledger.register("timer", () => {events.push("timer");});
    context.replaceStyle("skin.css", "body { color: red; }");
  }});
  assert.equal(mounted.state, "active");
  assert.equal(mounted.isCurrent(1), true);
  await mounted.dispose();
  assert.deepEqual(events, ["style", "remove-style", "timer", "listener"]);
  assert.equal(mounted.ledger.size, 0);
});

test("ignores UI writes from a context superseded by a newer generation", async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstContext: {replaceStyle(key: string, css: string): void} | undefined;
  const host = {
    mount: (slot: string) => ({
      appendStyle: (key: string) => { events.push(`style:${slot}:${key}`); },
      removeStyle: (key: string) => { events.push(`remove:${slot}:${key}`); }
    }),
    showError: () => {},
    supportsCapability: () => true
  };
  const adapter = new HostSlotRuntimeAdapter({profile, host, timeoutMs: 100});
  const first = adapter.mount({slot: "session", kind: "region", scope: "window", capabilities: descriptor.capabilities, generation: 1, component: async ({context}) => {
    firstContext = context;
    await firstReleased;
    context.replaceStyle("late.css", "old");
  }});
  const second = await adapter.mount({slot: "session", kind: "region", scope: "window", capabilities: descriptor.capabilities, generation: 2, component: ({context}) => {
    context.replaceStyle("current.css", "new");
  }});
  releaseFirst();
  const firstResult = await first;
  assert.equal(firstContext?.replaceStyle !== undefined, true);
  assert.equal(firstResult.isCurrent(), false);
  assert.deepEqual(events, ["style:session:current.css"]);
  await firstResult.dispose();
  await second.dispose();
});

test("does not let an older concurrent mount reclaim the current generation", async () => {
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const adapter = new HostSlotRuntimeAdapter({profile, host: {mount: () => ({}), showError: () => {}, supportsCapability: () => true}, timeoutMs: 100});
  const first = adapter.mount({slot: "session", kind: "region", scope: "window", capabilities: descriptor.capabilities, generation: 1, component: async () => {
    await firstReleased;
  }});
  const second = await adapter.mount({slot: "session", kind: "region", scope: "window", capabilities: descriptor.capabilities, generation: 2, component: () => {}});
  releaseFirst();
  const firstResult = await first;
  assert.equal(firstResult.isCurrent(), false);
  assert.equal(second.isCurrent(), true);
  await firstResult.dispose();
  assert.equal(second.isCurrent(), true);
  await second.dispose();
});

test("does not surface a stale mount failure after a newer generation is active", async () => {
  const errors: Error[] = [];
  let rejectFirst!: (error: Error) => void;
  const firstRejected = new Promise<void>((_, reject) => { rejectFirst = reject; });
  const adapter = new HostSlotRuntimeAdapter({profile, host: {mount: () => ({}), showError: (error) => { errors.push(error); }, supportsCapability: () => true}, timeoutMs: 100});
  const first = adapter.mount({slot: "session", kind: "region", scope: "window", capabilities: descriptor.capabilities, generation: 1, component: async () => {
    await firstRejected;
  }});
  const second = await adapter.mount({slot: "session", kind: "region", scope: "window", capabilities: descriptor.capabilities, generation: 2, component: () => {}});
  rejectFirst(new Error("stale failure"));
  await assert.rejects(() => first, /stale failure/);
  assert.deepEqual(errors, []);
  assert.equal(second.isCurrent(), true);
  await second.dispose();
});

test("rejects a kind, scope, or undeclared capability mismatch before component execution", async () => {
  let executed = false;
  const adapter = new HostSlotRuntimeAdapter({profile, host: {mount: () => ({}), showError: () => {}, supportsCapability: () => true}, timeoutMs: 100});
  await assert.rejects(() => adapter.mount({slot: "session", kind: "popup", scope: "window", capabilities: [], generation: 1, component: () => {executed = true;}}), /COMPATIBILITY_SLOT_KIND/);
  assert.equal(executed, false);
  await assert.rejects(() => adapter.mount({slot: "session", kind: "region", scope: "document", capabilities: [], generation: 1, component: () => {}}), /COMPATIBILITY_SLOT_SCOPE/);
  await assert.rejects(() => adapter.mount({slot: "session", kind: "region", scope: "window", capabilities: ["io.github.dsh-eac.window.controls@1"], generation: 1, component: () => {}}), /CAPABILITY_MISSING/);
});

test("theme registration and override are generation scoped and idempotently disposed", async () => {
  const registry = new ThemeRegistry();
  const first = registry.register("surface", {color: "red"}, {slot: "session", generation: 1});
  const second = registry.override("surface", {color: "blue"}, {slot: "session", generation: 2});
  assert.deepEqual(registry.get("surface"), {color: "blue"});
  assert.equal(first.isCurrent(), false);
  await second.dispose();
  assert.equal(registry.get("surface"), undefined);
  await second.dispose();
});

test("dsh adapter exposes only a typed mapped slot and theme disposer", async () => {
  const disposed: string[] = [];
  const adapter = new DshClientRuntimeAdapter({version: "0.1.6-alpha.2", mappings: [{slot: "session", key: "conversation.session", kind: "region", scope: "window"}]});
  const context = adapter.createContext({slot: "session", generation: 3, theme: {register: () => () => {disposed.push("theme");}}, slots: {register: (_key) => () => {disposed.push("slot");}}});
  const themeDisposer = context.theme.register("tokens", {primary: "red"});
  const slotDisposer = context.slots.register("conversation.session", {kind: "region", scope: "window"});
  await context.dispose();
  assert.deepEqual(disposed, ["slot", "theme"]);
  await themeDisposer();
  await slotDisposer();
});

test("dsh compatibility fixtures keep separate typed mappings for both supported versions", () => {
  for (const version of ["0.1.5-rc.2", "0.1.6-alpha.2"]) {
    const adapter = new DshClientRuntimeAdapter({version, mappings: [{slot: "session", key: "conversation.session", kind: "region", scope: "window"}]});
    assert.equal(adapter.version, version);
    assert.deepEqual(adapter.mappings[0], {slot: "session", key: "conversation.session", kind: "region", scope: "window"});
  }
});

test("runtime failure becomes stable error UI without cancelling another slot", async () => {
  const actions: string[] = [];
  const supervisor = new RuntimeSupervisor({
    errorSurface: {show: () => ({retry: () => {actions.push("retry");}, disable: () => {actions.push("disable");}, restoreDefault: () => {actions.push("default");}, viewLogs: () => {actions.push("logs");}, copyDiagnostics: () => "redacted", viewPackageSource: () => "third-party"})}
  });
  const result = await supervisor.run({slot: "session", generation: 4, packageId: "third.party.skin", packageVersion: "1.0.0", packageDigest: `sha256:${"a".repeat(64)}`, run: () => {throw new Error("secret /home/user/session");}});
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("the task was expected to fail");
  assert.equal(result.errorUi.copyDiagnostics(), "redacted");
  result.errorUi.retry();
  result.errorUi.disable();
  result.errorUi.restoreDefault();
  result.errorUi.viewLogs();
  assert.deepEqual(actions, ["retry", "disable", "default", "logs"]);
  assert.equal(result.errorUi.viewPackageSource(), "third-party");
  assert.equal(result.fault.message.includes("/home/user"), false);
  assert.equal(result.error.message, "secret /home/user/session");
  assert.equal(result.fault.message, "secret <redacted-path>");
  const fault = supervisor.diagnostics.export()[0];
  assert.equal(fault?.errorCode, "RUNTIME_COMPONENT_FAILED");
  assert.equal(fault?.message.includes("/home/user"), false);
});
