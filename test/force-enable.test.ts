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
  assert.equal(await controller.keep("session"), "kept");
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

test("a failed commit still restores the original binding and settles the confirmation", async () => {
  const events: string[] = [];
  const failures: string[] = [];
  const controller = new ForceEnableController({now: () => 0, timeoutMs: 30_000, onRestoreFailure: (slot, error) => { failures.push(`${slot}: ${error.message}`); }});
  for (const [label, commit] of [
    ["synchronous", () => { throw new Error("DISK FULL"); }],
    ["asynchronous", () => Promise.reject(new Error("DISK FULL"))]
  ] as const) {
    const restored: string[] = [];
    const pending = controller.begin({
      slot: "session", target: "skin.incompatible", previous: "system.default",
      activate: () => { events.push(`${label}:activate`); },
      restore: () => { restored.push(label); },
      commit
    });
    assert.equal(await controller.keep("session"), "restored", `${label} commit failure must not report a keep`);
    assert.equal(await pending.done, "restored");
    assert.equal(controller.active("session"), "system.default");
    assert.deepEqual(restored, [label], `${label} commit failure must still run restore()`);
  }
  assert.deepEqual(failures, []);
  assert.deepEqual(events, ["synchronous:activate", "asynchronous:activate"]);
});

test("a restore that itself fails is reported instead of stranding the confirmation", async () => {
  const failures: string[] = [];
  const controller = new ForceEnableController({now: () => 0, timeoutMs: 30_000, onRestoreFailure: (slot, error) => { failures.push(`${slot}: ${error.message}`); }});
  const pending = controller.begin({
    slot: "overlay", target: "skin.bad", previous: "system.default",
    activate: () => {}, commit: () => {}, restore: () => { throw new Error("host gone"); }
  });
  await controller.expireImmediately("overlay");
  assert.equal(await pending.done, "restored");
  assert.deepEqual(failures, ["overlay: host gone"]);
});

test("the confirmation deadline is tracked on a real clock and never keeps the host alive", async () => {
  const events: string[] = [];
  const controller = new ForceEnableController({timeoutMs: 15});
  const pending = controller.begin({slot: "session", target: "skin.slow", previous: "system.default", activate: () => {}, commit: () => {}, restore: () => { events.push("restore"); }});
  assert.deepEqual(controller.pending().map((entry) => entry.slot), ["session"]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await controller.expire("session");
  assert.equal(await pending.done, "restored");
  assert.deepEqual(events, ["restore"]);
  assert.equal(controller.active("session"), "system.default");
  assert.deepEqual(controller.pending(), []);
});

test("keep and expire race to one terminal state only", async () => {
  const controller = new ForceEnableController({now: () => 0, timeoutMs: 30_000});
  const restores: string[] = [];
  const pending = controller.begin({slot: "session", target: "skin.a", previous: "system.default", activate: () => {}, commit: () => {}, restore: () => { restores.push("restore"); }});
  await controller.expireImmediately("session");
  await assert.rejects(() => controller.keep("session"), /FORCE_ENABLE_NOT_PENDING/);
  assert.equal(await pending.done, "restored");
  assert.deepEqual(restores, ["restore"]);
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
