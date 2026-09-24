import assert from "node:assert/strict";
import test from "node:test";

import {DiagnosticStore, redact, redactDetail, validateFaultEvent, validateQuarantineRecords} from "../src/index.ts";

const fault = (overrides: Record<string, unknown> = {}) => ({
  timestamp: "2026-09-24T00:00:00.000Z",
  severity: "error",
  errorCode: "ACTIVATE_FAILED",
  message: "widget failed",
  correlationId: "c-1",
  generation: 4,
  regionOrSlot: "session",
  lifecycleStage: "activate",
  source: "third-party",
  recoverable: true,
  recoveryAction: "restore-default",
  bindingState: "failed",
  ...overrides
});

test("a loose diagnostic is completed into a valid FaultEvent", () => {
  const store = new DiagnosticStore();
  const result = store.record({errorCode: "PERSISTENCE_CORRUPT", regionOrSlot: "session", lifecycleStage: "recovery", message: "unreadable"});
  assert.equal(result.recorded, true);
  if (!result.recorded) assert.fail("expected the record to be accepted");
  assert.equal(result.fault.severity, "error");
  assert.equal(result.fault.source, "third-party");
  assert.equal(validateFaultEvent(result.fault).ok, true);
});

test("an entry that cannot satisfy the contract is counted, not laundered", () => {
  const store = new DiagnosticStore();
  const result = store.record({errorCode: "NOT_A_CATEGORY", regionOrSlot: "session", lifecycleStage: "activate", message: "x"});
  assert.equal(result.recorded, false);
  assert.equal(store.dropped, 1);
  assert.deepEqual(store.export(), []);
});

test("export is bounded and reports how much was discarded", () => {
  const store = new DiagnosticStore({limit: 3});
  for (const generation of [1, 2, 3, 4, 5]) store.record(fault({generation, correlationId: `c-${generation}`}));
  assert.equal(store.dropped, 2);
  assert.deepEqual(store.export().map((entry) => entry.generation), [3, 4, 5]);
  store.clear();
  assert.equal(store.dropped, 0);
});

test("package identity must arrive as a complete coordinate or not at all", () => {
  assert.ok(validateFaultEvent(fault({packageId: "a.b"})).issues.some((issue) => issue.code === "MANIFEST_FAULT_EVENT_PACKAGE"));
  assert.equal(validateFaultEvent(fault({packageId: "a.b", packageVersion: "1.0.0", packageDigest: `sha256:${"a".repeat(64)}`})).ok, true);
  assert.ok(validateFaultEvent(fault({packageId: "a.b", packageVersion: "1.0.0", packageDigest: "sha256:zz"})).issues.some((issue) => issue.code === "MANIFEST_FAULT_EVENT_PACKAGE"));
});

test("detail payloads are hashed unless they are contract identifiers", () => {
  const store = new DiagnosticStore();
  const result = store.record(fault({detail: {packageId: "a.b", generation: 4, prompt: "the user typed a secret here", nested: {path: "C:\\Users\\bob\\note.txt"}}}));
  assert.equal(result.recorded, true);
  if (!result.recorded) assert.fail("expected the record to be accepted");
  const detail = result.fault.detail!;
  assert.deepEqual(Object.keys(detail).sort(), ["generation", "nested", "packageId", "prompt"]);
  assert.match(String(detail.prompt), /^#[0-9a-f]{16}$/);
  assert.match(String(detail.nested), /^#[0-9a-f]{16}$/);
  assert.equal(detail.packageId, "a.b");
  assert.equal(detail.generation, 4);
});

test("quarantine history must itself satisfy the error-code contract", () => {
  assert.equal(validateQuarantineRecords([{packageId: "a.b", slot: "session", reason: "HEALTH_FAILED", timestamp: "2026-09-24T00:00:00.000Z"}]).ok, true);
  assert.ok(validateQuarantineRecords([{packageId: "a.b", slot: "session", reason: "because", timestamp: "2026-09-24T00:00:00.000Z"}]).issues.some((issue) => issue.code === "PERSISTENCE_QUARANTINE_REASON"));
  assert.ok(validateQuarantineRecords({}).issues.some((issue) => issue.code === "PERSISTENCE_QUARANTINE"));
});

test("redact removes credentials and filesystem roots", () => {
  const BS = String.fromCharCode(92);
  const cases: Array<[string, string[]]> = [
    [`C:${BS}Users${BS}operator${BS}skins${BS}theme.css is locked`, ["operator", "skins"]],
    [`the mount landed on ${BS}${BS}fileserver${BS}orders${BS}theme.css`, ["fileserver", "orders"]],
    ["mounted /home/operator/.dsh/skins/overlay", ["/home/operator", "operator"]],
    ["the store {\"root\":\"/srv/dsh/skins/overlay\"} failed, then /var/log/dsh", ["/srv/dsh", "/var/log"]],
    ["home is ~/.dsh/skins", [".dsh"]],
    ["opening file:///home/operator/.dsh/skins/theme.css failed", ["/home/operator"]],
    ["token=s3cr3tvalue with Authorization: Bearer abc.def.ghi-jkl and cookie: sid=0123456789ab", ["s3cr3tvalue", "abc.def.ghi-jkl", "0123456789ab"]]
  ];
  for (const [message, secrets] of cases) {
    const output = redact(message);
    for (const secret of secrets) assert.ok(!output.includes(secret), `${JSON.stringify(message)} leaked ${JSON.stringify(secret)} as ${JSON.stringify(output)}`);
    assert.ok(output.includes("<redacted"), `${JSON.stringify(message)} was not redacted at all`);
  }
});

test("redact keeps the diagnostic signal a skin author needs", () => {
  const kept = [
    "failed to read regions/session/entry.js: ENOENT",
    "opening ./regions/session/theme.css or a-b/c/theme.css failed",
    "asset regions/session/theme.css is 0 bytes at 2026-09-24 in range ^0.3.0",
    "contribution overlay.main needs io.github.dsh-eac.ui.notifications@1.0.0",
    "checking 100%coverage.css against theme-.css"
  ];
  for (const message of kept) assert.equal(redact(message), message);
});

test("redactDetail keeps contract coordinates and hashes everything else", () => {
  const home = `/home/operator/${"x".repeat(64)}`;
  const detail = redactDetail({slot: "overlay", contribution: "overlay.main", generation: 7, packageId: "third.party.skin", home, retry: 3, nested: {path: home}});
  assert.equal(detail.slot, "overlay");
  assert.equal(detail.contribution, "overlay.main");
  assert.equal(detail.generation, 7);
  assert.equal(detail.packageId, "third.party.skin");
  assert.match(String(detail.retry), /^#[0-9a-f]{16}$/, "a field the contract does not name is opaque, even a number");
  assert.match(String(detail.home), /^#[0-9a-f]{16}$/);
  assert.match(String(detail.nested), /^#[0-9a-f]{16}$/, "a nested object is hashed rather than walked");
  assert.equal(detail.home, redactDetail({home}).home, "the hash is stable across runs");
});
