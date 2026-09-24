import assert from "node:assert/strict";
import {appendFile, mkdir, mkdtemp, readFile, readdir, stat, utimes} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {LOG_POLICY, StructuredLog, validateFaultEvent, type FaultEvent} from "../src/index.ts";

const BS = String.fromCharCode(92);
const NOW = new Date("2026-09-24T08:00:00.000Z");
const clock = (offsetMs = 0) => {
  let current = NOW.getTime();
  return () => {
    const date = new Date(current);
    current += offsetMs;
    return date;
  };
};

function fault(overrides: Partial<FaultEvent> = {}): FaultEvent {
  return {
    timestamp: NOW.toISOString(),
    severity: "error",
    errorCode: "ACTIVATE_HEALTH",
    message: "the overlay failed its health probe",
    correlationId: "overlay-1",
    generation: 1,
    regionOrSlot: "overlay",
    lifecycleStage: "health",
    source: "third-party",
    recoverable: true,
    recoveryAction: "restore-default",
    bindingState: "failed",
    ...overrides
  };
}

async function log(options: Partial<{directory: string; basename: string; maxFileBytes: number; retentionDays: number; now: () => Date}> = {}): Promise<StructuredLog> {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), "skin-log-"));
  return new StructuredLog({directory, ...(options.basename === undefined ? {} : {basename: options.basename}), ...(options.maxFileBytes === undefined ? {} : {maxFileBytes: options.maxFileBytes}), ...(options.retentionDays === undefined ? {} : {retentionDays: options.retentionDays}), now: options.now ?? clock()});
}

const lines = async (path: string): Promise<Record<string, unknown>[]> => (await readFile(path, "utf8")).split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);

test("the contract fixes rotation and retention for v1", async () => {
  const opened = await log();
  assert.equal(opened.maxFileBytes, LOG_POLICY.maxFileBytes);
  assert.equal(opened.retentionDays, LOG_POLICY.retentionDays);
  for (const options of [{maxFileBytes: 0}, {maxFileBytes: Number.NaN}, {retentionDays: -1}] as const) {
    assert.throws(() => new StructuredLog({directory: opened.directory, ...options}), RangeError);
  }
});

test("every write appends exactly one whole JSON object and stamps a missing timestamp", async () => {
  const store = await log();
  const withoutStamp = {...fault()} as Record<string, unknown>;
  delete withoutStamp.timestamp;
  assert.equal((await store.write(fault())).written, true);
  assert.equal((await store.write(withoutStamp)).written, true);
  const written = await lines(store.activePath);
  assert.equal(written.length, 2);
  assert.equal(typeof written[1]?.timestamp, "string");
  assert.match(String(written[1]?.timestamp), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("redaction happens before persistence, so a secret never reaches the file", async () => {
  const store = await log();
  await store.write(fault({
    message: `C:\\Users\\operator\\skins\\theme.css and /home/operator/skins/theme.css broke, token=s3cr3tvalue for regions/session/entry.js at 2026-09-24`,
    detail: {slot: "overlay", home: "C:\\Users\\operator", retry: 3}
  }));
  await store.flush();
  const raw = await readFile(store.activePath, "utf8");
  for (const secret of ["s3cr3tvalue", "/home/", "Users", "operator"]) assert.ok(!raw.includes(secret), `the persisted line must not contain ${secret}`);
  const [entry] = await lines(store.activePath);
  const message = String(entry?.message);
  assert.ok(message.includes("<redacted-path>"), message);
  assert.ok(message.includes("token=<redacted>"), message);
  assert.ok(message.includes("regions/session/entry.js"), "a package-relative path stays readable");
  assert.ok(message.includes("2026-09-24"), "an ISO date is not a path");
  assert.deepEqual((entry?.detail as Record<string, unknown>).slot, "overlay");
  assert.equal(typeof (entry?.detail as Record<string, unknown>).home, "string");
  assert.match(String((entry?.detail as Record<string, unknown>).home), /^#[0-9a-f]{16}$/);
  assert.match(String((entry?.detail as Record<string, unknown>).retry), /^#[0-9a-f]{16}$/);
});

test("an entry that claims a FaultEvent errorCode is refused rather than silently truncated", async () => {
  const store = await log();
  const outcomes = [
    await store.write(fault({errorCode: "NOT_A_CATEGORY_VALUE"})),
    await store.write({...fault(), severity: "info"} as unknown as FaultEvent),
    await store.write(fault({packageId: "third.party.skin"})),
    await store.write(fault({message: "a credential token=hunter2secret"}))
  ];
  assert.deepEqual(outcomes.map((outcome) => outcome.written), [false, false, false, true]);
  for (const outcome of outcomes.slice(0, 3)) assert.match(String(outcome.rejected), /FaultEvent contract/);
  const written = await lines(store.activePath);
  assert.equal(written.length, 1);
  assert.equal(written[0]?.message, "a credential token=<redacted>");
  assert.equal((await readdir(store.directory)).length, 1);
});

test("an ordinary operational line is written without inventing FaultEvent fields", async () => {
  const store = await log();
  assert.equal((await store.write({level: "info", message: "the skin cache was warmed"})).written, true);
  assert.deepEqual(await lines(store.activePath), [{level: "info", message: "the skin cache was warmed", timestamp: NOW.toISOString()}]);
});

test("the active file rotates at the byte limit and reads span both generations", async () => {
  const probe = await log({directory: await mkdtemp(join(tmpdir(), "skin-log-"))});
  await probe.write(fault({correlationId: "c0"}));
  await probe.flush();
  const oneLine = (await stat(probe.activePath)).size;
  assert.ok(oneLine > 0);
  const directory = await mkdtemp(join(tmpdir(), "skin-log-"));
  const store = await log({directory, maxFileBytes: oneLine * 2});
  const rotated: boolean[] = [];
  for (const index of [1, 2, 3, 4, 5]) rotated.push((await store.write(fault({correlationId: `c${index}`}))).rotated === true);
  assert.deepEqual(rotated, [false, false, true, false, true], "the limit is checked before the append, so no file may grow past twice it");
  const names = await readdir(directory);
  assert.equal(names.filter((name) => name.startsWith("skin-events-")).length, 2);
  assert.equal(names.filter((name) => name === "skin-events.jsonl").length, 1);
  for (const name of names) assert.ok((await stat(join(directory, name))).size <= oneLine * 2, `${name} outgrew the limit`);
  assert.deepEqual((await store.read(2)).map((entry) => entry.correlationId), ["c4", "c5"]);
  assert.equal((await store.read(99)).length, 5);
});

test("two rotations in one tick archive separately instead of overwriting each other", async () => {
  const store = await log({maxFileBytes: 1});
  for (const index of [1, 2, 3]) assert.equal((await store.write(fault({correlationId: `c${index}`}))).rotated, index > 1);
  const archives = (await readdir(store.directory)).filter((name) => name.startsWith("skin-events-")).sort();
  assert.equal(archives.length, 2, "a same-millisecond rotation must not discard an older archive");
  assert.equal((await store.read(99)).length, 3);
});

test("rotate is explicit, idempotent on an empty log, and readable afterwards", async () => {
  const store = await log();
  assert.equal(await store.rotate(), false, "nothing is archived for a log that never wrote");
  await store.write(fault());
  await store.flush();
  assert.equal(await store.rotate(), true);
  assert.deepEqual(await lines(store.activePath).catch(() => [] as Record<string, unknown>[]), []);
  assert.equal((await store.read(5)).length, 1);
  assert.equal(await store.rotate(), false);
});

test("purge applies the retention floor to archived files only", async () => {
  const store = await log({retentionDays: 30});
  await mkdir(store.directory, {recursive: true});
  const aged = join(store.directory, "skin-events-2020-01-01T00-00-00-000Z.jsonl");
  const fresh = join(store.directory, "skin-events-2026-09-23T00-00-00-000Z.jsonl");
  const unrelated = join(store.directory, "something-else.jsonl");
  const old = NOW.getTime() - 40 * 24 * 60 * 60 * 1000;
  for (const path of [aged, fresh, unrelated]) await appendFile(path, `${JSON.stringify(fault())}\n`, "utf8");
  await utimes(aged, new Date(old), new Date(old));
  await store.write(fault({message: "current"}));
  assert.equal(await store.purge(), 1);
  const names = await readdir(store.directory);
  assert.ok(!names.includes("skin-events-2020-01-01T00-00-00-000Z.jsonl"));
  assert.deepEqual(names.filter((name) => name.startsWith("skin-events")).sort(), ["skin-events-2026-09-23T00-00-00-000Z.jsonl", "skin-events.jsonl"]);
  assert.ok(names.includes("something-else.jsonl"), "a purge never touches another subsystem's files");
});

test("purge tolerates a missing directory and concurrent writes stay whole-line", async () => {
  const missing = new StructuredLog({directory: join(await mkdtemp(join(tmpdir(), "skin-log-")), "not-created")});
  assert.equal(await missing.purge(), 0);
  await Promise.all(Array.from({length: 20}, (_, index) => missing.write(fault({message: `line ${index}`, correlationId: `c${index}`}))));
  await missing.flush();
  const written = await lines(missing.activePath);
  assert.equal(written.length, 20);
  assert.deepEqual(written.map((entry) => entry.correlationId), Array.from({length: 20}, (_, index) => `c${index}`));
  for (const entry of written) assert.equal(validateFaultEvent(entry).ok, true);
});
