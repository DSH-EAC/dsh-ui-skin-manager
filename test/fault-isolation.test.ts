import assert from "node:assert/strict";
import test from "node:test";

import {runIsolatedSlots} from "../src/index.ts";

for (const [name, failure] of [
  ["throw", () => {throw new Error("throw");}],
  ["rejection", async () => Promise.reject(new Error("reject"))],
  ["timeout", async () => new Promise(() => {})]
] as const) {
  test(`isolates one slot ${name} without cancelling a healthy slot`, async () => {
    let healthyCommitted = false;
    const result = await runIsolatedSlots([
      {slot: "broken", timeoutMs: 5, run: failure},
      {slot: "healthy", timeoutMs: 100, run: async () => {healthyCommitted = true; return "ok";}}
    ]);
    assert.equal(healthyCommitted, true);
    assert.equal(result.get("healthy")?.ok, true);
    assert.equal(result.get("broken")?.ok, false);
  });
}
