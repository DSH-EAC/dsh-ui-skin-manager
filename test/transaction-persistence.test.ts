import assert from "node:assert/strict";
import test from "node:test";

import {SlotTransactionCoordinator} from "../src/index.ts";
import type {SlotBinding} from "../src/index.ts";

const binding = (slot: string, generation: number, id: string): SlotBinding => ({
  slot,
  package: {id, version: "1.0.0", digest: `sha256:${id.padEnd(64, "x")}`},
  contribution: `${id}.contribution`,
  generation,
  state: "staged"
});

test("does not publish an active binding when persistence rejects the committed generation", async () => {
  const coordinator = new SlotTransactionCoordinator({timeoutMs: 100});
  const events: string[] = [];
  await assert.rejects(() => coordinator.switch({
    slot: "session",
    binding: binding("session", 1, "b"),
    contexts: [{id: "webview", activate: () => { events.push("activate"); }, rollback: () => { events.push("rollback"); }}],
    persist: async () => { throw new Error("disk full"); }
  }), /disk full/);
  assert.equal(coordinator.active("session"), undefined);
  assert.deepEqual(events, ["activate", "rollback"]);
});
