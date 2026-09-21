import assert from "node:assert/strict";
import test from "node:test";

import {ForceEnableController} from "../src/index.ts";

test("force enable requires target slot, exposes a 30 second confirmation, and commits only when kept", async () => {
  let now = 1_000;
  const events: string[] = [];
  const controller = new ForceEnableController({now: () => now, timeoutMs: 30_000});
  const pending = controller.begin({slot: "session", target: "skin.incompatible", previous: "system.default", activate: () => { events.push("activate"); }, restore: () => { events.push("restore"); }, commit: () => { events.push("commit"); }});
  assert.equal(pending.state, "pending");
  assert.equal(pending.expiresAt, 31_000);
  assert.equal(controller.active("session"), "skin.incompatible");
  controller.keep("session");
  assert.equal(await pending.done, "kept");
  assert.deepEqual(events, ["activate", "commit"]);
});

test("force enable restores the previous binding on timeout and never promotes pending after restart", async () => {
  let now = 0;
  const events: string[] = [];
  const controller = new ForceEnableController({now: () => now, timeoutMs: 30_000});
  const pending = controller.begin({slot: "overlay", target: "skin.bad", previous: "system.default", activate: () => {}, restore: () => { events.push("restore"); }, commit: () => { events.push("commit"); }});
  now = 30_001;
  await controller.expire("overlay");
  assert.equal(await pending.done, "restored");
  assert.equal(controller.active("overlay"), "system.default");
  assert.deepEqual(events, ["restore"]);
  controller.recoverPending();
  assert.equal(controller.active("overlay"), "system.default");
});

test("force enable restores immediately when target activation fails", async () => {
  const events: string[] = [];
  const controller = new ForceEnableController({now: () => 0, timeoutMs: 30_000});
  const pending = controller.begin({slot: "session", target: "skin.broken", previous: "system.default", activate: () => { throw new Error("crash"); }, restore: () => { events.push("restore"); }, commit: () => { events.push("commit"); }});
  assert.equal(await pending.done, "restored");
  assert.equal(controller.active("session"), "system.default");
  assert.deepEqual(events, ["restore"]);
});

test("force enable restores on crash and rejects overlapping requests for one slot", async () => {
  const events: string[] = [];
  const controller = new ForceEnableController({now: () => 0, timeoutMs: 30_000});
  const pending = controller.begin({slot: "session", target: "skin.one", previous: "system.default", activate: () => {}, restore: () => { events.push("restore"); }, commit: () => {}});
  assert.throws(() => controller.begin({slot: "session", target: "skin.two", previous: "system.default", activate: () => {}, restore: () => {}, commit: () => {}}), /FORCE_ENABLE_PENDING/);
  await controller.crashRecover();
  assert.equal(await pending.done, "restored");
  assert.equal(controller.active("session"), "system.default");
  assert.deepEqual(events, ["restore"]);
});
