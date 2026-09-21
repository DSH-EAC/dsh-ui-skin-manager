import {HOST_PROFILE_ID, MANIFEST_API_VERSION, MANIFEST_KIND} from "./constants.ts";
import type {DisposeReport, FaultEvent, HostProfile, SkinManifest, SlotBinding, SlotContribution, ValidationIssue, ValidationResult} from "./models.ts";

const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RANGE = /^(?:[~^]|>=?|<=?)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\s+(?:<|<=|>|>=)\d+\.\d+\.\d+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const record = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const issue = (issues: ValidationIssue[], code: string, path: string, message: string): void => { issues.push({code, path, message}); };
const result = <T>(value: unknown, issues: ValidationIssue[]): ValidationResult<T> => issues.length === 0 ? {ok: true, issues, value: value as T} : {ok: false, issues};

function safePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\\") || path.includes("\0")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  const parts = path.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function versionTuple(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersion(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function satisfiesVersion(version: string, range: string): boolean {
  const actual = versionTuple(version);
  const match = /^(\^|~|>=|<=|>|<)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(range);
  if (!actual || !match) return false;
  const expected = versionTuple(match[2]!);
  if (!expected) return false;
  const comparison = compareVersion(actual, expected);
  switch (match[1] ?? "") {
    case "^": return comparison >= 0 && actual[0] === expected[0];
    case "~": return comparison >= 0 && actual[0] === expected[0] && actual[1] === expected[1];
    case ">=": return comparison >= 0;
    case "<=": return comparison <= 0;
    case ">": return comparison > 0;
    case "<": return comparison < 0;
    default: return comparison === 0;
  }
}

export function validateSlotContribution(value: unknown, path = "contribution"): ValidationResult<SlotContribution> {
  const issues: ValidationIssue[] = [];
  if (!record(value)) {
    issue(issues, "MANIFEST_CONTRIBUTION", path, "must be an object");
    return result(value, issues);
  }
  if (typeof value.id !== "string" || !ID.test(value.id)) issue(issues, "MANIFEST_CONTRIBUTION_ID", `${path}.id`, "must be a lowercase identifier");
  if (typeof value.slot !== "string" || value.slot.length === 0) issue(issues, "MANIFEST_CONTRIBUTION_SLOT", `${path}.slot`, "must be a non-empty slot identifier");
  if (!safePath(value.entry)) issue(issues, "PATH_UNSAFE", `${path}.entry`, "must be a normalized relative path");
  if (!strings(value.assets)) issue(issues, "MANIFEST_ASSETS", `${path}.assets`, "must be a string array");
  else value.assets.forEach((asset, index) => { if (!safePath(asset)) issue(issues, "PATH_UNSAFE", `${path}.assets[${index}]`, "must be a normalized relative path"); });
  if (value.style !== undefined) {
    if (!record(value.style) || !safePath(value.style.entry) || !strings(value.style.assets)) issue(issues, "MANIFEST_STYLE", `${path}.style`, "must declare a safe entry and assets array");
  }
  if (!record(value.requires) || !strings(value.requires.capabilities) || !strings(value.requires.slotKind) || !strings(value.requires.slotScope)) issue(issues, "MANIFEST_REQUIRES", `${path}.requires`, "must declare capabilities, slotKind and slotScope arrays");
  if (!record(value.lifecycle) || ["mount", "health", "unmount"].some((key) => typeof value.lifecycle?.[key] !== "string")) issue(issues, "MANIFEST_LIFECYCLE", `${path}.lifecycle`, "must declare mount, health and unmount hooks");
  return result(value, issues);
}

export function validateHostProfile(value: unknown): ValidationResult<HostProfile> {
  const issues: ValidationIssue[] = [];
  if (!record(value)) {
    issue(issues, "MANIFEST_HOST_PROFILE", "$", "must be an object");
    return result(value, issues);
  }
  if (value.id !== HOST_PROFILE_ID) issue(issues, "MANIFEST_HOST_PROFILE_ID", "$.id", `must equal ${HOST_PROFILE_ID}`);
  if (typeof value.version !== "string" || !SEMVER.test(value.version)) issue(issues, "MANIFEST_VERSION", "$.version", "must be SemVer");
  if (!strings(value.regions) || value.regions.length === 0) issue(issues, "MANIFEST_REGIONS", "$.regions", "must be a non-empty string array");
  if (!Array.isArray(value.slots) || value.slots.length === 0) issue(issues, "MANIFEST_SLOTS", "$.slots", "must be a non-empty array");
  else for (const [index, slot] of value.slots.entries()) {
    if (!record(slot) || typeof slot.id !== "string" || typeof slot.region !== "string" || typeof slot.kind !== "string" || typeof slot.scope !== "string" || !record(slot.propsSchema) || typeof slot.mountContract !== "string" || !record(slot.zIndexPolicy) || !strings(slot.capabilities) || typeof slot.fallbackSkin !== "string") issue(issues, "MANIFEST_SLOT_DESCRIPTOR", `$.slots[${index}]`, "is incomplete");
  }
  if (!strings(value.instanceKinds)) issue(issues, "MANIFEST_INSTANCE_KINDS", "$.instanceKinds", "must be a string array");
  if (!record(value.zIndexPolicy)) issue(issues, "MANIFEST_Z_INDEX", "$.zIndexPolicy", "must be an object");
  if (!Array.isArray(value.capabilities)) issue(issues, "MANIFEST_CAPABILITIES", "$.capabilities", "must be an array");
  if (!Array.isArray(value.dshAdapters)) issue(issues, "MANIFEST_DSH_ADAPTERS", "$.dshAdapters", "must be an array");
  if (!record(value.fallbackSkin) || typeof value.fallbackSkin.id !== "string" || !SEMVER.test(value.fallbackSkin.version) || !DIGEST.test(value.fallbackSkin.digest)) issue(issues, "MANIFEST_FALLBACK", "$.fallbackSkin", "must be an exact package coordinate");
  return result(value, issues);
}

export function validateSkinManifest(value: unknown, options: {profile?: HostProfile} = {}): ValidationResult<SkinManifest> {
  const issues: ValidationIssue[] = [];
  if (!record(value)) {
    issue(issues, "MANIFEST_ROOT", "$", "must be an object");
    return result(value, issues);
  }
  if (value.apiVersion !== MANIFEST_API_VERSION) issue(issues, "MANIFEST_API_VERSION", "$.apiVersion", `must equal ${MANIFEST_API_VERSION}`);
  if (value.kind !== MANIFEST_KIND) issue(issues, "MANIFEST_KIND", "$.kind", `must equal ${MANIFEST_KIND}`);
  if (!record(value.metadata)) issue(issues, "MANIFEST_METADATA", "$.metadata", "must be an object");
  else {
    if (typeof value.metadata.id !== "string" || !ID.test(value.metadata.id)) issue(issues, "MANIFEST_ID", "$.metadata.id", "must be a lowercase reverse-DNS identifier");
    if (typeof value.metadata.version !== "string" || !SEMVER.test(value.metadata.version)) issue(issues, "MANIFEST_VERSION", "$.metadata.version", "must be SemVer");
    for (const field of ["name", "author"]) if (typeof value.metadata[field] !== "string" || value.metadata[field].length === 0) issue(issues, "MANIFEST_METADATA", `$.metadata.${field}`, "must be a non-empty string");
  }
  if (!record(value.engines) || typeof value.engines.manager !== "string" || !RANGE.test(value.engines.manager) || typeof value.engines.hostProfile !== "string" || !RANGE.test(value.engines.hostProfile) || (value.engines.dsh !== undefined && (typeof value.engines.dsh !== "string" || !RANGE.test(value.engines.dsh)))) issue(issues, "COMPATIBILITY_RANGE", "$.engines", "contains an invalid SemVer range");
  if (value.dependencies !== undefined) {
    if (!Array.isArray(value.dependencies)) issue(issues, "DEPENDENCY_INVALID", "$.dependencies", "must be an array");
    else value.dependencies.forEach((dependency, index) => {
      if (!record(dependency) || typeof dependency.id !== "string" || !ID.test(dependency.id) || typeof dependency.range !== "string" || !RANGE.test(dependency.range)) issue(issues, "DEPENDENCY_INVALID", `$.dependencies[${index}]`, "must contain a valid ID and SemVer range");
    });
  }
  if (!Array.isArray(value.contributions) || value.contributions.length === 0) issue(issues, "MANIFEST_CONTRIBUTIONS", "$.contributions", "must be a non-empty array");
  else value.contributions.forEach((contribution, index) => issues.push(...validateSlotContribution(contribution, `$.contributions[${index}]`).issues));
  const assetPaths = new Set<string>();
  if (!Array.isArray(value.assets)) issue(issues, "MANIFEST_ASSETS", "$.assets", "must be an array");
  else value.assets.forEach((asset, index) => {
    if (!record(asset) || !safePath(asset.path)) issue(issues, "PATH_UNSAFE", `$.assets[${index}].path`, "must be a normalized relative path");
    else if (assetPaths.has(asset.path)) issue(issues, "ASSET_DUPLICATE", `$.assets[${index}].path`, "duplicates a normalized asset path");
    else assetPaths.add(asset.path);
    if (!record(asset) || typeof asset.sha256 !== "string" || !SHA256.test(asset.sha256)) issue(issues, "INTEGRITY_DIGEST", `$.assets[${index}].sha256`, "must be a lowercase SHA-256 hex digest");
  });
  if (!record(value.integrity)) issue(issues, "INTEGRITY_MAP", "$.integrity", "must be an object");
  else if (Array.isArray(value.assets)) value.assets.forEach((asset, index) => {
    if (record(asset) && typeof asset.path === "string" && value.integrity[asset.path] !== asset.sha256) issue(issues, "INTEGRITY_MISMATCH", `$.assets[${index}]`, "asset and integrity digests differ");
  });
  if (Array.isArray(value.contributions)) {
    const coordinates = new Set<string>();
    value.contributions.forEach((contribution, index) => {
      if (!record(contribution)) return;
      const coordinate = `${contribution.slot}\0${contribution.id}`;
      if (coordinates.has(coordinate)) issue(issues, "CONTRIBUTION_DUPLICATE", `$.contributions[${index}]`, "duplicates slot and contribution ID");
      coordinates.add(coordinate);
      const references = [contribution.entry, ...(strings(contribution.assets) ? contribution.assets : [])];
      if (record(contribution.style)) references.push(contribution.style.entry, ...(strings(contribution.style.assets) ? contribution.style.assets : []));
      references.forEach((reference) => { if (typeof reference === "string" && !assetPaths.has(reference)) issue(issues, "ASSET_UNDECLARED", `$.contributions[${index}]`, `${reference} is not declared in assets`); });
    });
  }
  const profile = options.profile;
  if (profile && record(value.engines) && typeof value.engines.hostProfile === "string") {
    if (!satisfiesVersion(profile.version, value.engines.hostProfile)) issue(issues, "COMPATIBILITY_HOST_PROFILE", "$.engines.hostProfile", "does not match the active host profile");
    if (Array.isArray(value.contributions)) for (const [index, contribution] of value.contributions.entries()) {
      if (!record(contribution) || !record(contribution.requires)) continue;
      const slot = profile.slots.find((candidate) => candidate.id === contribution.slot);
      if (!slot) { issue(issues, "COMPATIBILITY_SLOT", `$.contributions[${index}].slot`, "is not present in the host profile"); continue; }
      if (strings(contribution.requires.slotKind) && !contribution.requires.slotKind.includes(slot.kind)) issue(issues, "COMPATIBILITY_SLOT_KIND", `$.contributions[${index}]`, "slot kind is incompatible");
      if (strings(contribution.requires.slotScope) && !contribution.requires.slotScope.includes(slot.scope)) issue(issues, "COMPATIBILITY_SLOT_SCOPE", `$.contributions[${index}]`, "slot scope is incompatible");
      if (strings(contribution.requires.capabilities)) for (const required of contribution.requires.capabilities) {
        const separator = required.lastIndexOf("@");
        const id = separator > 0 ? required.slice(0, separator) : required;
        const range = separator > 0 ? required.slice(separator + 1) : "";
        const available = profile.capabilities.find((candidate) => candidate.id === id);
        if (!available || !satisfiesVersion(available.version, range)) issue(issues, "COMPATIBILITY_CAPABILITY", `$.contributions[${index}].requires.capabilities`, `${required} is unavailable`);
      }
    }
  }
  return result(value, issues);
}

export function validateSlotBinding(value: unknown): ValidationResult<SlotBinding> {
  const issues: ValidationIssue[] = [];
  if (!record(value) || typeof value.slot !== "string" || !record(value.package) || typeof value.package.id !== "string" || !ID.test(value.package.id) || typeof value.package.version !== "string" || !SEMVER.test(value.package.version) || typeof value.package.digest !== "string" || !DIGEST.test(value.package.digest) || typeof value.contribution !== "string" || !Number.isSafeInteger(value.generation) || value.generation < 0 || !["staged", "active", "failed", "inactive"].includes(value.state)) issue(issues, "MANIFEST_SLOT_BINDING", "$", "is not a valid SlotBinding");
  return result(value, issues);
}

export function validateFaultEvent(value: unknown): ValidationResult<FaultEvent> {
  const issues: ValidationIssue[] = [];
  if (!record(value) || typeof value.timestamp !== "string" || !ISO_DATE.test(value.timestamp) || !["warning", "error", "fatal"].includes(value.severity) || typeof value.errorCode !== "string" || typeof value.message !== "string" || typeof value.correlationId !== "string" || !Number.isSafeInteger(value.generation) || typeof value.regionOrSlot !== "string" || typeof value.lifecycleStage !== "string" || !["official", "third-party"].includes(value.source) || typeof value.recoverable !== "boolean" || typeof value.recoveryAction !== "string" || typeof value.bindingState !== "string") issue(issues, "MANIFEST_FAULT_EVENT", "$", "is not a valid FaultEvent");
  return result(value, issues);
}

export function validateDisposeReport(value: unknown): ValidationResult<DisposeReport> {
  const issues: ValidationIssue[] = [];
  if (!record(value) || !Number.isSafeInteger(value.generation) || typeof value.slot !== "string" || !Number.isSafeInteger(value.attempted) || !Number.isSafeInteger(value.released) || !strings(value.remaining) || !strings(value.errors) || typeof value.timedOut !== "boolean" || typeof value.completedAt !== "string" || !ISO_DATE.test(value.completedAt)) issue(issues, "MANIFEST_DISPOSE_REPORT", "$", "is not a valid DisposeReport");
  return result(value, issues);
}
