import assert from "node:assert/strict";
import test from "node:test";

import {EffectLedger, SlotLifecycle} from "../src/index.ts";

test("runs staged lifecycle in order and disposes old only after commit", async () => {
  const events: string[] = [];
  const lifecycle = new SlotLifecycle({timeoutMs: 100});
  const result = await lifecycle.switch({slot: "session", generation: 2, active: {deactivate: async () => {events.push("deactivate-old");}}, hooks: {
    inspect: async () => {events.push("inspect");}, prepare: async () => {events.push("prepare");}, activate: async () => {events.push("activate");},
    health: async () => {events.push("health");}, commit: async () => {events.push("commit");}, rollback: async () => {events.push("rollback");}
  }});
  assert.equal(result.state, "active");
  assert.deepEqual(events, ["inspect", "prepare", "activate", "health", "commit", "deactivate-old"]);
});

test("failed activation rolls back staged effects and preserves old active", async () => {
  const events: string[] = [];
  const ledger = new EffectLedger({slot: "session", generation: 2});
  ledger.register("listener", async () => {events.push("release-listener");});
  const lifecycle = new SlotLifecycle({timeoutMs: 100});
  await assert.rejects(() => lifecycle.switch({slot: "session", generation: 2, active: {deactivate: async () => {events.push("deactivate-old");}}, ledger, hooks: {
    inspect: async () => {events.push("inspect");}, prepare: async () => {events.push("prepare");}, activate: async () => {throw new Error("broken");},
    health: async () => {events.push("health");}, commit: async () => {events.push("commit");}, rollback: async () => {events.push("rollback");}
  }}));
  assert.deepEqual(events, ["inspect", "prepare", "rollback", "release-listener"]);
});

test("disposer is reverse ordered and idempotent", async () => {
  const events: string[] = [];
  const ledger = new EffectLedger({slot: "session", generation: 1});
  ledger.register("first", async () => {events.push("first");});
  ledger.register("second", async () => {events.push("second");});
  const first = await ledger.dispose();
  const second = await ledger.dispose();
  assert.deepEqual(events, ["second", "first"]);
  assert.deepEqual(second, first);
  assert.deepEqual(first.remaining, []);
});

test("timeout aborts only the candidate and clears its ledger", async () => {
  const ledger = new EffectLedger({slot: "session", generation: 2});
  let released = false;
  ledger.register("timer", async () => {released = true;});
  const lifecycle = new SlotLifecycle({timeoutMs: 5});
  await assert.rejects(() => lifecycle.switch({slot: "session", generation: 2, ledger, hooks: {
    inspect: async () => {}, prepare: async () => {},
    activate: async ({signal}) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), {once: true})),
    health: async () => {}, commit: async () => {}, rollback: async () => {}
  }}), /timed out/);
  assert.equal(released, true);
  assert.equal(ledger.size, 0);
});
