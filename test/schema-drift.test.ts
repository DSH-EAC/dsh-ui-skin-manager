import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {
  validateDisposeReport,
  validateFaultEvent,
  validateHostProfile,
  validateInstalledPackage,
  validateSkinManifest,
  validateSlotBinding,
  validateSlotContribution,
  type DisposeReport,
  type FaultEvent,
  type SkinManifest
} from "../src/index.ts";
import {SchemaLibrary, unsupportedKeywords, validateAgainst, type JsonSchema} from "./support/json-schema.ts";

const NAMES = ["skin-package.schema.json", "slot-contribution.schema.json", "host-profile.schema.json", "slot-binding.schema.json", "fault-event.schema.json", "dispose-report.schema.json"];

async function library(): Promise<SchemaLibrary> {
  return new SchemaLibrary(await Promise.all(NAMES.map(async (name) => JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8")) as JsonSchema)));
}

const read = async (path: string): Promise<any> => JSON.parse(await readFile(new URL(`./fixtures/${path}`, import.meta.url), "utf8"));

const mutate = (base: any, patch: Record<string, unknown>): any => ({...structuredClone(base), ...patch});
const drop = (base: any, key: string): any => {
  const clone = structuredClone(base);
  delete clone[key];
  return clone;
};

type Expectation = "both accept" | "both refuse" | "schema is looser" | "schema is stricter";

interface Case {
  label: string;
  value: unknown;
  expect: Expectation;
  why?: string;
}

const outcomes = (schemaOk: boolean, validatorOk: boolean): Expectation =>
  schemaOk && validatorOk ? "both accept" : !schemaOk && !validatorOk ? "both refuse" : schemaOk ? "schema is looser" : "schema is stricter";

async function compare(name: string, validator: (value: unknown) => boolean, cases: Case[]): Promise<void> {
  const set = await library();
  const schema = set.document(name);
  const problems: string[] = [];
  for (const item of cases) {
    const schemaOk = validateAgainst(schema, item.value, set).length === 0;
    const validatorOk = validator(item.value);
    const outcome = outcomes(schemaOk, validatorOk);
    if (outcome !== item.expect) {
      problems.push(`${item.label}: expected ${item.expect}, got ${outcome} (schema ${schemaOk ? "accepted" : "refused"}, validator ${validatorOk ? "accepted" : "refused"})`);
    } else if (outcome !== "both accept" && outcome !== "both refuse" && item.why === undefined) {
      problems.push(`${item.label}: a ${outcome} case must say why in the contract`);
    }
  }
  assert.deepEqual(problems, [], `${name}\n  ${problems.join("\n  ")}`);
}

test("every published schema stays inside the keyword subset this gate evaluates", async () => {
  const set = await library();
  assert.deepEqual(set.names, [...NAMES].sort(), "the shipped schemas and the gate must list the same files");
  for (const name of NAMES) {
    const schema = set.document(name);
    assert.equal(String(schema.$schema), "https://json-schema.org/draft/2020-12/schema", `${name} must state its dialect`);
    assert.equal(String(schema.$id).split("/").pop(), name, `${name} is served from its $id`);
    assert.deepEqual(unsupportedKeywords(schema), [], `${name} uses a keyword this gate cannot evaluate, so it would pass vacuously`);
    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref") refs.push(String(value));
        else walk(value);
      }
    };
    walk(schema);
    assert.ok(refs.length > 0 || name === "dispose-report.schema.json", `${name} declares no reusable definitions`);
    for (const ref of refs) assert.doesNotThrow(() => set.resolve(ref, schema), `${name}: ${ref} does not resolve`);
  }
});

const manifest = await read("valid/minimal-skin.json") as SkinManifest;
const profile = await read("valid/host-profile.json");
const contribution = manifest.contributions[0];

test("skin-package.schema.json and validateSkinManifest accept the same documents", async () => {
  await compare("skin-package.schema.json", (value) => validateSkinManifest(value).ok, [
    {label: "the shipped minimal package", value: manifest, expect: "both accept"},
    {label: "a package with a dsh engine", value: mutate(manifest, {engines: {...manifest.engines, dsh: ">=0.1.5 <1.0.0"}}), expect: "both accept"},
    {label: "an equals comparator", value: mutate(manifest, {engines: {manager: "=1.0.0", hostProfile: "^0.3.0"}}), expect: "both accept"},
    {label: "a compound and alternation range", value: mutate(manifest, {engines: {manager: ">=1.0.0 <2.0.0 || 3.0.0", hostProfile: "~0.3.0"}}), expect: "both accept"},
    {label: "a range padded with whitespace", value: mutate(manifest, {engines: {manager: "  ^1.0.0   ^1.2.0  ", hostProfile: "^0.3.0"}}), expect: "both accept"},
    {label: "a prerelease and build range", value: mutate(manifest, {engines: {manager: "^1.0.0-rc.1+build.7", hostProfile: "^0.3.0"}}), expect: "both accept"},
    {label: "a withdrawn dependencies key", value: drop(manifest, "dependencies"), expect: "both accept"},
    {label: "a second apiVersion", value: mutate(manifest, {apiVersion: "dsh.eac.ui-skin/v2"}), expect: "both refuse"},
    {label: "the wrong kind", value: mutate(manifest, {kind: "Plugin"}), expect: "both refuse"},
    {label: "an uppercase package id", value: mutate(manifest, {metadata: {...manifest.metadata, id: "Upper Case"}}), expect: "both refuse"},
    {label: "a version with a v prefix", value: mutate(manifest, {metadata: {...manifest.metadata, version: "v1.2.3"}}), expect: "both refuse", why: "a SemVer core has no v prefix; accepting one here would make two spellings of one version"},
    {label: "a version with a leading-zero prerelease", value: mutate(manifest, {metadata: {...manifest.metadata, version: "1.2.3-01"}}), expect: "both refuse"},
    {label: "a missing engines axis", value: mutate(manifest, {engines: {manager: "^1.0.0"}}), expect: "both refuse"},
    {label: "an unknown engines axis", value: mutate(manifest, {engines: {...manifest.engines, node: ">=18"}}), expect: "both refuse"},
    {label: "a wildcard range", value: mutate(manifest, {dependencies: [{id: "system.default", range: "1.x"}]}), expect: "both refuse"},
    {label: "a dependency without a range", value: mutate(manifest, {dependencies: [{id: "system.default"}]}), expect: "both refuse"},
    {label: "a traversal asset path", value: mutate(manifest, {assets: [{path: "../escape.js", sha256: "a".repeat(64)}], integrity: {"../escape.js": "a".repeat(64)}}), expect: "both refuse"},
    {label: "an empty asset path segment", value: mutate(manifest, {assets: [{path: "regions//entry.js", sha256: "a".repeat(64)}], integrity: {"regions//entry.js": "a".repeat(64)}}), expect: "both refuse"},
    {label: "an absolute asset path", value: mutate(manifest, {assets: [{path: "/etc/passwd", sha256: "a".repeat(64)}], integrity: {"/etc/passwd": "a".repeat(64)}}), expect: "both refuse"},
    {label: "a non-hex asset digest", value: mutate(manifest, {assets: [{path: "entry.js", sha256: "xyz"}], integrity: {"entry.js": "xyz"}}), expect: "both refuse"},
    {label: "an integrity map that is not a digest", value: mutate(manifest, {integrity: {...manifest.integrity, "regions/session/entry.js": "nope"}}), expect: "both refuse"},
    {label: "no contributions", value: mutate(manifest, {contributions: []}), expect: "both refuse"},
    {label: "a contribution with an unsafe entry", value: mutate(manifest, {contributions: [mutate(contribution, {entry: "../../etc/passwd"})]}), expect: "both refuse"},
    {label: "an asset and integrity map that disagree", value: mutate(manifest, {integrity: {"regions/session/entry.js": "c".repeat(64), "regions/session/styles.css": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}), expect: "schema is looser", why: "one field agreeing with another is a cross-field rule that JSON Schema cannot state"},
    {label: "a contribution referencing an undeclared asset", value: mutate(manifest, {contributions: [mutate(contribution, {assets: ["regions/session/missing.css"]}), ]}), expect: "schema is looser", why: "a contribution must reference declared assets, which is a cross-item rule JSON Schema cannot state"},
    {label: "two assets with the same path", value: mutate(manifest, {assets: [manifest.assets[0], {...manifest.assets[0]!}]}), expect: "schema is looser", why: "duplicate detection needs a projected uniqueness rule JSON Schema cannot state"},
    {label: "an unknown top-level field", value: mutate(manifest, {scripts: {build: "escape.exe"}}), expect: "schema is stricter", why: "the schema freezes the wire format while the validator keeps forward compatibility for a field a newer manager adds"}
  ]);
});

test("slot-contribution.schema.json and validateSlotContribution accept the same documents", async () => {
  await compare("slot-contribution.schema.json", (value) => validateSlotContribution(value).ok, [
    {label: "the shipped contribution", value: contribution, expect: "both accept"},
    {label: "no style block", value: drop(contribution, "style"), expect: "both accept"},
    {label: "a backslash entry", value: mutate(contribution, {entry: "regions\\session\\entry.js"}), expect: "both refuse"},
    {label: "a current-directory asset segment", value: mutate(contribution, {assets: ["./entry.js"]}), expect: "both refuse"},
    {label: "a non-empty style entry", value: mutate(contribution, {style: {entry: "styles//theme.css", assets: []}}), expect: "both refuse"},
    {label: "a missing lifecycle hook", value: mutate(contribution, {lifecycle: {mount: "mount", health: "health"}}), expect: "both refuse"},
    {label: "an empty slotKind list", value: mutate(contribution, {requires: {...(contribution as any).requires, slotKind: []}}), expect: "both refuse"},
    {label: "an empty requirement string", value: mutate(contribution, {requires: {...(contribution as any).requires, capabilities: [""]}}), expect: "both refuse"},
    {label: "an unknown requires field", value: mutate(contribution, {requires: {...(contribution as any).requires, widgets: ["a"]}}), expect: "schema is stricter", why: "the validator ignores an extra requires field so a future axis does not invalidate an older package"}
  ]);
});

test("host-profile.schema.json and validateHostProfile accept the same documents", async () => {
  await compare("host-profile.schema.json", (value) => validateHostProfile(value).ok, [
    {label: "the shipped desktop profile", value: profile, expect: "both accept"},
    {label: "an instance kind this profile never heard of", value: mutate(profile, {instanceKinds: ["dock-card"]}), expect: "both accept", why: "instance kinds are host-defined, so the schema must not freeze them"},
    {label: "a capability without a version", value: mutate(profile, {capabilities: [{id: "io.github.dsh-eac.ui.notifications"}]}), expect: "both refuse"},
    {label: "a capability with an unqualified id", value: mutate(profile, {capabilities: [{id: "Notifications", version: "1.0.0"}]}), expect: "both refuse"},
    {label: "a zero-index range with a string bound", value: mutate(profile, {zIndexPolicy: {...profile.zIndexPolicy, session: {min: "0", max: 99}}}), expect: "both refuse"},
    {label: "a slot with an empty region", value: mutate(profile, {slots: [mutate(profile.slots[0], {region: ""})]}), expect: "both refuse"},
    {label: "a slot with a bad zIndexPolicy", value: mutate(profile, {slots: [mutate(profile.slots[0], {zIndexPolicy: {min: 0}})]}), expect: "both refuse"},
    {label: "no regions", value: mutate(profile, {regions: []}), expect: "both refuse"},
    {label: "a fallback skin without a digest", value: mutate(profile, {fallbackSkin: {id: "system.default", version: "2.0.0"}}), expect: "both refuse"},
    {label: "a fallback digest without the sha256 prefix", value: mutate(profile, {fallbackSkin: {...profile.fallbackSkin, digest: "c".repeat(64)}}), expect: "both refuse"},
    {label: "a profile version that is not SemVer", value: mutate(profile, {version: "0.3"}), expect: "both refuse"},
    {label: "an unknown top-level field", value: mutate(profile, {"x-experimental": true}), expect: "schema is stricter", why: "a host profile is authored by the host, so the validator tolerates a key a newer host adds"}
  ]);
});

test("slot-binding.schema.json and validateSlotBinding accept the same documents", async () => {
  const binding = {slot: "session", package: {id: "system.default", version: "2.0.0", digest: `sha256:${"a".repeat(64)}`}, contribution: "session.main", generation: 4, state: "active"};
  await compare("slot-binding.schema.json", (value) => validateSlotBinding(value).ok, [
    {label: "an active binding", value: binding, expect: "both accept"},
    {label: "a staged binding", value: mutate(binding, {state: "staged"}), expect: "both accept"},
    {label: "an unknown state", value: mutate(binding, {state: "pending"}), expect: "both refuse"},
    {label: "a negative generation", value: mutate(binding, {generation: -1}), expect: "both refuse"},
    {label: "a fractional generation", value: mutate(binding, {generation: 1.5}), expect: "both refuse"},
    {label: "a package id that is not lowercase", value: mutate(binding, {package: {...binding.package, id: "System Default"}}), expect: "both refuse"},
    {label: "a package version with a v prefix", value: mutate(binding, {package: {...binding.package, version: "v2.0.0"}}), expect: "both refuse"},
    {label: "a bare hex digest", value: mutate(binding, {package: {...binding.package, digest: "a".repeat(64)}}), expect: "both refuse"},
    {label: "an empty contribution", value: mutate(binding, {contribution: ""}), expect: "both refuse"},
    {label: "a binding with an extra field", value: mutate(binding, {mountPoint: "#root"}), expect: "schema is stricter", why: "the validator ignores a field a newer binding record adds, the wire format does not"}
  ]);
});

test("fault-event.schema.json and validateFaultEvent accept the same documents", async () => {
  const fault: FaultEvent = {
    timestamp: "2026-09-24T08:00:00.000Z", severity: "error", errorCode: "ACTIVATE_HEALTH", message: "the probe failed",
    correlationId: "overlay-4", generation: 4, regionOrSlot: "overlay", lifecycleStage: "health", source: "third-party",
    recoverable: true, recoveryAction: "restore-default", bindingState: "failed"
  };
  const withPackage = mutate(fault, {packageId: "third.party.skin", packageVersion: "1.0.0", packageDigest: `sha256:${"b".repeat(64)}`});
  await compare("fault-event.schema.json", (value) => validateFaultEvent(value).ok, [
    {label: "a slot fault", value: fault, expect: "both accept"},
    {label: "a complete package triple", value: withPackage, expect: "both accept"},
    {label: "a detail map", value: mutate(fault, {detail: {attempt: 2}}), expect: "both accept"},
    {label: "an empty message", value: mutate(fault, {message: ""}), expect: "both accept"},
    {label: "a package id with no version or digest", value: mutate(fault, {packageId: "third.party.skin"}), expect: "both refuse"},
    {label: "a lower-case error code", value: mutate(fault, {errorCode: "activate_health"}), expect: "both refuse"},
    {label: "an error code outside the categories", value: mutate(fault, {errorCode: "NETWORK_TIMEOUT"}), expect: "both refuse"},
    {label: "a date with no instant", value: mutate(fault, {timestamp: "2026-09-24"}), expect: "both refuse"},
    {label: "a severity the contract does not define", value: mutate(fault, {severity: "info"}), expect: "both refuse"},
    {label: "a negative generation", value: mutate(fault, {generation: -1}), expect: "both refuse"},
    {label: "a detail that is not a map", value: mutate(fault, {detail: "attempt 2"}), expect: "both refuse"},
    {label: "an empty recovery action", value: mutate(fault, {recoveryAction: ""}), expect: "both refuse"},
    {label: "a source that is not official or third-party", value: mutate(fault, {source: "curated"}), expect: "both refuse"}
  ]);
});

test("dispose-report.schema.json and validateDisposeReport accept the same documents", async () => {
  const report: DisposeReport = {generation: 4, slot: "overlay", attempted: 2, released: 2, remaining: [], errors: [], timedOut: false, completedAt: "2026-09-24T08:00:00.000Z"};
  await compare("dispose-report.schema.json", (value) => validateDisposeReport(value).ok, [
    {label: "a clean report", value: report, expect: "both accept"},
    {label: "a timed-out report with residue", value: mutate(report, {released: 1, remaining: ["listener"], errors: ["dispose hung"], timedOut: true}), expect: "both accept"},
    {label: "a non-integer attempted count", value: mutate(report, {attempted: 1.5}), expect: "both refuse"},
    {label: "a negative released count", value: mutate(report, {released: -1}), expect: "both refuse"},
    {label: "a missing completion stamp", value: drop(report, "completedAt"), expect: "both refuse"},
    {label: "a timedOut that is not a boolean", value: mutate(report, {timedOut: "false"}), expect: "both refuse"},
    {label: "an unknown field", value: mutate(report, {durationMs: 12}), expect: "schema is stricter", why: "a report may gain timing fields without invalidating an older reader"}
  ]);
});

test("an installed-package record is validated against the shape the index stores", async () => {
  const record = {manifest, versionPath: "/packages/system.default/2.0.0/a", digest: `sha256:${"a".repeat(64)}`, source: "embedded", origin: "file:///pack/system.default.dshpack", official: true};
  assert.equal(validateInstalledPackage(record).ok, true);
  assert.equal(validateInstalledPackage({...record, digest: "sha256:zz"}).ok, false);
  assert.equal(validateInstalledPackage({...record, source: "mirror"}).ok, false);
  assert.equal(validateInstalledPackage({...record, manifest: "not a manifest"}).ok, false);
});
