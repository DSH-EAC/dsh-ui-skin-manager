import assert from "node:assert/strict";
import test from "node:test";

import {SlotTransactionCoordinator, TransactionStageError} from "../src/index.ts";
import type {SlotBinding} from "../src/index.ts";

const binding = (slot: string, generation: number, id: string): SlotBinding => ({
  slot,
  package: {id, version: "1.0.0", digest: `sha256:${id.padEnd(64, "x")}`},
  contribution: `${id}.contribution`,
  generation,
  state: "staged"
});

test("commits all context acknowledgements as one slot generation and disposes old after commit", async () => {
  const events: string[] = [];
  const coordinator = new SlotTransactionCoordinator({timeoutMs: 100});
  const result = await coordinator.switch({
    slot: "session",
    binding: binding("session", 2, "skin.b"),
    contexts: ["shell", "webview"].map((id) => ({
      id,
      prepare: () => { events.push(`${id}:prepare`); },
      preload: () => { events.push(`${id}:preload`); },
      activate: () => { events.push(`${id}:activate`); },
      health: () => { events.push(`${id}:health`); },
      commit: () => { events.push(`${id}:commit`); },
      disposeOld: () => { events.push(`${id}:dispose-old`); }
    })),
    previous: {binding: binding("session", 1, "skin.a"), dispose: () => { events.push("previous:dispose"); }}
  });
  assert.equal(result.state, "active");
  assert.deepEqual(events.slice(0, 10), [
    "shell:prepare", "webview:prepare", "shell:preload", "webview:preload",
    "shell:activate", "webview:activate", "shell:health", "webview:health",
    "shell:commit", "webview:commit"
  ]);
  assert.deepEqual(events.slice(10), ["shell:dispose-old", "webview:dispose-old", "previous:dispose"]);
});

test("rolls back every context and leaves old binding when any stage fails", async () => {
  const events: string[] = [];
  const coordinator = new SlotTransactionCoordinator({timeoutMs: 100});
  await assert.rejects(() => coordinator.switch({
    slot: "session",
    binding: binding("session", 2, "skin.b"),
    contexts: [
      {id: "shell", activate: () => { events.push("shell:activate"); }, rollback: () => { events.push("shell:rollback"); }},
      {id: "webview", health: () => { throw new Error("health failed"); }, rollback: () => { events.push("webview:rollback"); }}
    ],
    previous: {binding: binding("session", 1, "skin.a"), dispose: () => { events.push("old:dispose"); }}
  }), /health failed/);
  assert.deepEqual(events, ["shell:activate", "webview:rollback", "shell:rollback"]);
  assert.equal(coordinator.active("session")?.package.id, "skin.a");
});

test("serializes rapid switches per slot while allowing different slots to proceed independently", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = new SlotTransactionCoordinator({timeoutMs: 100});
  const first = coordinator.switch({slot: "session", binding: binding("session", 1, "a"), contexts: [{id: "webview", activate: async () => { order.push("a:start"); await gate; order.push("a:end"); }}]});
  const second = coordinator.switch({slot: "session", binding: binding("session", 2, "b"), contexts: [{id: "webview", activate: () => { order.push("b"); }}]});
  const other = coordinator.switch({slot: "overlay", binding: binding("overlay", 1, "overlay"), contexts: [{id: "webview", activate: () => { order.push("overlay"); }}]});
  await other;
  assert.deepEqual(order, ["a:start", "overlay"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["a:start", "overlay", "a:end", "b"]);
  assert.equal(coordinator.active("session")?.package.id, "b");
});

test("rejects a stale generation before it can replace the active slot", async () => {
  const coordinator = new SlotTransactionCoordinator({timeoutMs: 100});
  await coordinator.switch({slot: "session", binding: binding("session", 2, "b"), contexts: []});
  await assert.rejects(() => coordinator.switch({slot: "session", binding: binding("session", 1, "a"), contexts: []}), (error: unknown) => error instanceof TransactionStageError && error.stage === "generation");
  assert.equal(coordinator.active("session")?.package.id, "b");
});

test("a post-commit cleanup failure never un-publishes the generation that was already persisted", async () => {
  const coordinator = new SlotTransactionCoordinator({timeoutMs: 100});
  let persisted: SlotBinding | undefined;
  let rollbacks = 0;
  const result = await coordinator.switch({
    slot: "session",
    binding: binding("session", 2, "skin.b"),
    previous: {binding: binding("session", 1, "skin.a"), dispose: () => { throw new Error("old contribution leaked"); }},
    persist: async (binding) => { persisted = binding; },
    contexts: [{id: "webview", activate: () => {}, commit: () => {}, rollback: () => { rollbacks += 1; }}]
  });
  assert.equal(persisted?.generation, 2);
  assert.equal(coordinator.active("session")?.generation, 2, "memory must agree with the persisted generation");
  assert.equal(coordinator.active("session")?.package.id, "skin.b");
  assert.equal(rollbacks, 0, "committed contexts are not rolled back by a later cleanup failure");
  assert.deepEqual(result.disposeErrors, ["dispose-old (previous): old contribution leaked"]);
});

test("a context that fails to dispose old is reported per context while the slot stays active", async () => {
  const coordinator = new SlotTransactionCoordinator({timeoutMs: 100});
  const result = await coordinator.switch({
    slot: "session",
    binding: binding("session", 2, "skin.b"),
    contexts: [
      {id: "shell", commit: () => {}, disposeOld: () => {}},
      {id: "webview", commit: () => {}, disposeOld: () => { throw new Error("listener stuck"); }}
    ]
  });
  assert.equal(coordinator.active("session")?.generation, 2);
  assert.deepEqual(result.disposeErrors, ["dispose-old (webview): listener stuck"]);
});

test("the next switch cannot reuse a generation that was already committed", async () => {
  const coordinator = new SlotTransactionCoordinator({timeoutMs: 100});
  await coordinator.switch({
    slot: "session",
    binding: binding("session", 2, "skin.b"),
    previous: {binding: binding("session", 1, "skin.a"), dispose: () => { throw new Error("dispose failed"); }},
    contexts: [{id: "webview", commit: () => {}}]
  });
  await assert.rejects(
    () => coordinator.switch({slot: "session", binding: binding("session", 2, "skin.c"), contexts: [{id: "webview"}]}),
    (error: unknown) => error instanceof TransactionStageError && error.stage === "generation"
  );
});

test("rollback runs in reverse registration order and a failing rollback cannot mask the original cause", async () => {
  const events: string[] = [];
  const coordinator = new SlotTransactionCoordinator({timeoutMs: 100});
  await assert.rejects(() => coordinator.switch({
    slot: "session",
    binding: binding("session", 2, "skin.b"),
    contexts: [
      {id: "first", activate: () => {}, rollback: () => { events.push("first"); }},
      {id: "second", activate: () => {}, rollback: () => { throw new Error("rollback failed"); }},
      {id: "third", health: () => { throw new Error("health failed"); }, rollback: () => { events.push("third"); }}
    ]
  }), /health failed/);
  assert.deepEqual(events, ["third", "first"]);
});

test("a stage that overruns its deadline fails as a timeout instead of hanging the slot queue", async () => {
  const coordinator = new SlotTransactionCoordinator({timeoutMs: 10});
  await assert.rejects(
    () => coordinator.switch({slot: "session", binding: binding("session", 2, "skin.b"), contexts: [{id: "webview", activate: () => new Promise(() => {})}]}),
    (error: unknown) => error instanceof TransactionStageError && error.stage === "activate" && /timed out after 10ms/.test(error.message)
  );
  const followUp = await coordinator.switch({slot: "session", binding: binding("session", 3, "skin.c"), contexts: [{id: "webview", activate: () => {}}]});
  assert.equal(followUp.generation, 3);
});

test("requires every context to acknowledge commit before publishing active state", async () => {
  const coordinator = new SlotTransactionCoordinator({timeoutMs: 100});
  await assert.rejects(() => coordinator.switch({
    slot: "session",
    binding: binding("session", 2, "b"),
    contexts: [{id: "shell", commit: () => {}}, {id: "webview", commit: () => { throw new Error("ack missing"); }, rollback: () => {}}]
  }), /ack missing/);
  assert.equal(coordinator.active("session"), undefined);
});
