import assert from "node:assert/strict";
import test from "node:test";

import {EffectLedger, LifecycleStageError, SlotLifecycle} from "../src/index.ts";

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

test("a hanging disposer is cut off and reported as a remaining effect", async () => {
  const ledger = new EffectLedger({slot: "session", generation: 3, timeoutMs: 10});
  ledger.register("stuck", () => new Promise<void>(() => {}));
  ledger.register("clean", async () => {});
  const report = await ledger.dispose();
  assert.equal(report.timedOut, true);
  assert.equal(report.attempted, 2);
  assert.equal(report.released, 1);
  assert.deepEqual(report.remaining, ["stuck"]);
  assert.deepEqual(report.errors, ["stuck timed out after 10ms"]);
  assert.equal(ledger.disposed, true);
  assert.deepEqual(await ledger.dispose(), report);
});

test("registering on a disposed ledger is refused instead of recreating an effect", async () => {
  const ledger = new EffectLedger({slot: "session", generation: 1});
  await ledger.dispose();
  assert.throws(() => ledger.register("late", () => {}), /DISPOSE_LEDGER_CLOSED/);
});

test("the failing stage is reported together with the dispose report of the candidate", async () => {
  const ledger = new EffectLedger({slot: "session", generation: 4, timeoutMs: 20});
  ledger.register("observer", async () => {});
  const lifecycle = new SlotLifecycle({timeoutMs: 50});
  await assert.rejects(() => lifecycle.switch({slot: "session", generation: 4, ledger, hooks: {
    inspect: async () => {}, prepare: async () => {},
    activate: async () => { throw new Error("component exploded"); },
    health: async () => {}, commit: async () => {}, rollback: async () => {}
  }}), (error: unknown) => {
    assert.ok(error instanceof LifecycleStageError);
    assert.equal(error.stage, "activate");
    assert.equal(error.slot, "session");
    assert.equal(error.generation, 4);
    assert.equal(error.report.released, 1);
    assert.deepEqual(error.report.remaining, []);
    return true;
  });
});

test("preload runs between prepare and activate and is optional", async () => {
  const events: string[] = [];
  const lifecycle = new SlotLifecycle({timeoutMs: 50});
  const hooks = {
    inspect: async () => {events.push("inspect");}, prepare: async () => {events.push("prepare");},
    activate: async () => {events.push("activate");}, health: async () => {events.push("health");},
    commit: async () => {events.push("commit");}, rollback: async () => {events.push("rollback");}
  };
  await lifecycle.switch({slot: "session", generation: 1, hooks});
  assert.deepEqual(events, ["inspect", "prepare", "activate", "health", "commit"]);
  events.length = 0;
  await lifecycle.switch({slot: "session", generation: 2, hooks: {...hooks, preload: async () => {events.push("preload");}}});
  assert.deepEqual(events, ["inspect", "prepare", "preload", "activate", "health", "commit"]);
});

test("configured deadlines are clamped to the ADR maxima and applied per stage", () => {
  const lifecycle = new SlotLifecycle();
  assert.equal(lifecycle.deadline("activate"), 10_000);
  assert.equal(lifecycle.deadline("prepare"), 10_000);
  assert.equal(lifecycle.deadline("dispose"), 10_000);
  assert.equal(new SlotLifecycle({timeoutMs: 1_000_000}).deadline("health"), 10_000);
  assert.equal(new SlotLifecycle({deadlines: {health: 250}}).deadline("health"), 250);
  assert.equal(new SlotLifecycle({deadlines: {health: 250}}).deadline("activate"), 10_000);
  assert.throws(() => new SlotLifecycle({deadlines: {activate: 0}}), /activate deadline must be positive/);
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
