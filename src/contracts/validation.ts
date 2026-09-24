import {ERROR_CATEGORIES, HOST_PROFILE_ID, MANIFEST_API_VERSION, MANIFEST_KIND} from "./constants.ts";
import {isValidRange, isValidVersion, satisfiesVersion} from "./semver.ts";
import type {BindingGeneration, DisposeReport, FaultEvent, HostProfile, InstalledPackage, QuarantineRecord, SkinManifest, SlotBinding, SlotContribution, ValidationIssue, ValidationResult} from "./models.ts";

export {compareVersions, isValidRange, isValidVersion, normalizeRange, parseVersion, satisfiesVersion} from "./semver.ts";

const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ERROR_CODE = new RegExp(`^(?:${ERROR_CATEGORIES.join("|")})_[A-Z0-9][A-Z0-9_]*$`);

const record = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const filled = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const filledStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(filled);
const requirementList = (value: unknown): value is string[] => filledStrings(value) && value.length > 0;
const zIndexRange = (value: unknown): value is {min: number; max: number} => record(value) && Number.isSafeInteger(value.min) && Number.isSafeInteger(value.max);
const issue = (issues: ValidationIssue[], code: string, path: string, message: string): void => { issues.push({code, path, message}); };
const result = <T>(value: unknown, issues: ValidationIssue[]): ValidationResult<T> => issues.length === 0 ? {ok: true, issues, value: value as T} : {ok: false, issues};

export function isErrorCode(value: unknown): value is string {
  return typeof value === "string" && ERROR_CODE.test(value);
}

export function isSafePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\\") || path.includes("\0")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  const parts = path.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function unsafePaths(issues: ValidationIssue[], paths: string[], path: string): void {
  paths.forEach((entry, index) => { if (!isSafePath(entry)) issue(issues, "PATH_UNSAFE", `${path}[${index}]`, "must be a normalized relative path"); });
}

export function validateSlotContribution(value: unknown, path = "contribution"): ValidationResult<SlotContribution> {
  const issues: ValidationIssue[] = [];
  if (!record(value)) {
    issue(issues, "MANIFEST_CONTRIBUTION", path, "must be an object");
    return result(value, issues);
  }
  if (typeof value.id !== "string" || !ID.test(value.id)) issue(issues, "MANIFEST_CONTRIBUTION_ID", `${path}.id`, "must be a lowercase identifier");
  if (typeof value.slot !== "string" || value.slot.length === 0) issue(issues, "MANIFEST_CONTRIBUTION_SLOT", `${path}.slot`, "must be a non-empty slot identifier");
  if (!isSafePath(value.entry)) issue(issues, "PATH_UNSAFE", `${path}.entry`, "must be a normalized relative path");
  if (!strings(value.assets)) issue(issues, "MANIFEST_ASSETS", `${path}.assets`, "must be a string array");
  else unsafePaths(issues, value.assets, `${path}.assets`);
  if (value.style !== undefined) {
    if (!record(value.style) || !isSafePath(value.style.entry) || !strings(value.style.assets)) issue(issues, "MANIFEST_STYLE", `${path}.style`, "must declare a safe entry and assets array");
    else unsafePaths(issues, value.style.assets, `${path}.style.assets`);
  }
  if (!record(value.requires) || !filledStrings(value.requires.capabilities) || !requirementList(value.requires.slotKind) || !requirementList(value.requires.slotScope)) issue(issues, "MANIFEST_REQUIRES", `${path}.requires`, "must declare non-empty slotKind and slotScope lists of non-empty strings");
  if (!record(value.lifecycle) || ["mount", "health", "unmount"].some((key) => {
    const hook: unknown = value.lifecycle?.[key];
    return typeof hook !== "string" || hook.length === 0;
  })) issue(issues, "MANIFEST_LIFECYCLE", `${path}.lifecycle`, "must declare mount, health and unmount hooks");
  return result(value, issues);
}

export function validateHostProfile(value: unknown): ValidationResult<HostProfile> {
  const issues: ValidationIssue[] = [];
  if (!record(value)) {
    issue(issues, "MANIFEST_HOST_PROFILE", "$", "must be an object");
    return result(value, issues);
  }
  if (value.id !== HOST_PROFILE_ID) issue(issues, "MANIFEST_HOST_PROFILE_ID", "$.id", `must equal ${HOST_PROFILE_ID}`);
  if (!isValidVersion(value.version)) issue(issues, "MANIFEST_VERSION", "$.version", "must be SemVer");
  if (!filledStrings(value.regions) || value.regions.length === 0) issue(issues, "MANIFEST_REGIONS", "$.regions", "must be a non-empty array of non-empty strings");
  if (!Array.isArray(value.slots) || value.slots.length === 0) issue(issues, "MANIFEST_SLOTS", "$.slots", "must be a non-empty array");
  else for (const [index, slot] of value.slots.entries()) {
    if (!record(slot) || !filled(slot.id) || !filled(slot.region) || !filled(slot.kind) || !filled(slot.scope) || !record(slot.propsSchema) || !filled(slot.mountContract) || !zIndexRange(slot.zIndexPolicy) || !filledStrings(slot.capabilities) || !filled(slot.fallbackSkin)) issue(issues, "MANIFEST_SLOT_DESCRIPTOR", `$.slots[${index}]`, "is incomplete");
  }
  if (!filledStrings(value.instanceKinds)) issue(issues, "MANIFEST_INSTANCE_KINDS", "$.instanceKinds", "must be an array of non-empty strings");
  if (!record(value.zIndexPolicy) || !Object.values(value.zIndexPolicy).every(zIndexRange)) issue(issues, "MANIFEST_Z_INDEX", "$.zIndexPolicy", "must map every region to an integer min and max");
  if (!Array.isArray(value.capabilities) || !value.capabilities.every((capability) => record(capability) && ID.test(String(capability.id)) && isValidVersion(capability.version))) issue(issues, "MANIFEST_CAPABILITIES", "$.capabilities", "must be an array of {id, version} capabilities");
  if (!Array.isArray(value.dshAdapters)) issue(issues, "MANIFEST_DSH_ADAPTERS", "$.dshAdapters", "must be an array");
  if (!record(value.fallbackSkin) || !ID.test(String(value.fallbackSkin.id)) || !isValidVersion(value.fallbackSkin.version) || !DIGEST.test(String(value.fallbackSkin.digest))) issue(issues, "MANIFEST_FALLBACK", "$.fallbackSkin", "must be an exact package coordinate");
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
    if (!isValidVersion(value.metadata.version)) issue(issues, "MANIFEST_VERSION", "$.metadata.version", "must be SemVer");
    for (const field of ["name", "author"]) if (typeof value.metadata[field] !== "string" || value.metadata[field].length === 0) issue(issues, "MANIFEST_METADATA", `$.metadata.${field}`, "must be a non-empty string");
  }
  if (!record(value.engines)) issue(issues, "COMPATIBILITY_RANGE", "$.engines", "must be an object");
  else {
    for (const field of ["manager", "hostProfile"] as const) {
      if (!isValidRange(value.engines[field])) issue(issues, "COMPATIBILITY_RANGE", `$.engines.${field}`, "must be a SemVer range using ^, ~, =, >, >=, < or <= comparators");
    }
    if (value.engines.dsh !== undefined && !isValidRange(value.engines.dsh)) issue(issues, "COMPATIBILITY_RANGE", "$.engines.dsh", "must be a SemVer range using ^, ~, =, >, >=, < or <= comparators");
    for (const key of Object.keys(value.engines)) {
      if (!["manager", "hostProfile", "dsh"].includes(key)) issue(issues, "COMPATIBILITY_RANGE", `$.engines.${key}`, "is not a known engine axis");
    }
  }
  if (value.dependencies !== undefined) {
    if (!Array.isArray(value.dependencies)) issue(issues, "DEPENDENCY_INVALID", "$.dependencies", "must be an array");
    else value.dependencies.forEach((dependency, index) => {
      if (!record(dependency) || typeof dependency.id !== "string" || !ID.test(dependency.id) || !isValidRange(dependency.range)) issue(issues, "DEPENDENCY_INVALID", `$.dependencies[${index}]`, "must contain a valid ID and SemVer range");
    });
  }
  if (!Array.isArray(value.contributions) || value.contributions.length === 0) issue(issues, "MANIFEST_CONTRIBUTIONS", "$.contributions", "must be a non-empty array");
  else value.contributions.forEach((contribution, index) => issues.push(...validateSlotContribution(contribution, `$.contributions[${index}]`).issues));
  const assetPaths = new Set<string>();
  if (!Array.isArray(value.assets)) issue(issues, "MANIFEST_ASSETS", "$.assets", "must be an array");
  else value.assets.forEach((asset, index) => {
    if (!record(asset) || !isSafePath(asset.path)) issue(issues, "PATH_UNSAFE", `$.assets[${index}].path`, "must be a normalized relative path");
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
  if (profile && record(value.engines) && isValidRange(value.engines.hostProfile)) {
    if (!satisfiesVersion(typeof profile.version === "string" ? profile.version : "", value.engines.hostProfile)) {
      issue(issues, "COMPATIBILITY_HOST_PROFILE", "$.engines.hostProfile", "does not match the active host profile");
    }
    if (Array.isArray(value.contributions) && Array.isArray(profile.slots) && Array.isArray(profile.capabilities)) for (const [index, contribution] of value.contributions.entries()) {
      if (!record(contribution) || !record(contribution.requires)) continue;
      const slot = profile.slots.find((candidate) => candidate?.id === contribution.slot);
      if (!slot) { issue(issues, "COMPATIBILITY_SLOT", `$.contributions[${index}].slot`, "is not present in the host profile"); continue; }
      if (strings(contribution.requires.slotKind) && !contribution.requires.slotKind.includes(slot.kind)) issue(issues, "COMPATIBILITY_SLOT_KIND", `$.contributions[${index}]`, "slot kind is incompatible");
      if (strings(contribution.requires.slotScope) && !contribution.requires.slotScope.includes(slot.scope)) issue(issues, "COMPATIBILITY_SLOT_SCOPE", `$.contributions[${index}]`, "slot scope is incompatible");
      if (strings(contribution.requires.capabilities)) for (const required of contribution.requires.capabilities) {
        const separator = required.lastIndexOf("@");
        const id = separator > 0 ? required.slice(0, separator) : required;
        const range = separator > 0 ? required.slice(separator + 1) : undefined;
        if (!ID.test(id)) { issue(issues, "COMPATIBILITY_CAPABILITY", `$.contributions[${index}].requires.capabilities`, `${required} is not a capability identifier with an optional @range`); continue; }
        if (range !== undefined && !isValidRange(range)) { issue(issues, "COMPATIBILITY_CAPABILITY", `$.contributions[${index}].requires.capabilities`, `${required} declares an invalid SemVer range`); continue; }
        const available = profile.capabilities.find((candidate) => candidate?.id === id);
        if (!available) issue(issues, "COMPATIBILITY_CAPABILITY", `$.contributions[${index}].requires.capabilities`, `${id} is not offered by the host profile`);
        else if (range !== undefined && !satisfiesVersion(available.version, range)) issue(issues, "COMPATIBILITY_CAPABILITY", `$.contributions[${index}].requires.capabilities`, `${id}@${range} is unavailable, host offers ${available.version}`);
      }
    }
  }
  return result(value, issues);
}

export function validateQuarantineRecords(value: unknown): ValidationResult<QuarantineRecord[]> {
  const issues: ValidationIssue[] = [];
  if (!Array.isArray(value)) {
    issue(issues, "PERSISTENCE_QUARANTINE", "$", "must be an array");
    return result(value, issues);
  }
  value.forEach((entry, index) => {
    const path = `$[${index}]`;
    if (!record(entry)) { issue(issues, "PERSISTENCE_QUARANTINE", path, "must be an object"); return; }
    if (typeof entry.packageId !== "string" || !ID.test(entry.packageId)) issue(issues, "PERSISTENCE_QUARANTINE_PACKAGE", `${path}.packageId`, "must be a lowercase identifier");
    if (typeof entry.slot !== "string" || entry.slot.length === 0) issue(issues, "PERSISTENCE_QUARANTINE_SLOT", `${path}.slot`, "must be a non-empty string");
    if (!ERROR_CODE.test(String(entry.reason))) issue(issues, "PERSISTENCE_QUARANTINE_REASON", `${path}.reason`, "must be a stable error code");
    if (!ISO_DATE.test(String(entry.timestamp))) issue(issues, "PERSISTENCE_QUARANTINE_TIMESTAMP", `${path}.timestamp`, "must be an ISO-8601 UTC instant");
  });
  return result(value, issues);
}

export function validateBindingGeneration(value: unknown): ValidationResult<BindingGeneration> {
  const issues: ValidationIssue[] = [];
  if (!record(value)) {
    issue(issues, "PERSISTENCE_BINDING_GENERATION", "$", "must be an object");
    return result(value, issues);
  }
  if (!Number.isSafeInteger(value.generation) || value.generation < 0) issue(issues, "PERSISTENCE_BINDING_GENERATION", "$.generation", "must be a non-negative integer");
  if (!record(value.bindings)) issue(issues, "PERSISTENCE_BINDING_RECORDS", "$.bindings", "must be an object");
  else {
    for (const [slot, binding] of Object.entries(value.bindings)) {
      const nested = validateSlotBinding(binding);
      if (!nested.ok) issues.push(...nested.issues.map((entry) => ({...entry, path: `$.bindings.${slot}`})));
      else if (binding.slot !== slot) issue(issues, "PERSISTENCE_BINDING_SLOT_KEY", `$.bindings.${slot}`, "key must equal the binding slot");
      // Slots switch independently (ADR 0002 section 3), so a slot keeps the generation it was bound at while the
      // file records the newest transaction. Only a binding from the future is incoherent.
      else if (Number.isSafeInteger(value.generation) && binding.generation > value.generation) issue(issues, "PERSISTENCE_BINDING_GENERATION_MISMATCH", `$.bindings.${slot}.generation`, "cannot exceed the committed generation");
    }
  }
  return result(value, issues);
}

export function validateSlotBinding(value: unknown): ValidationResult<SlotBinding> {
  const issues: ValidationIssue[] = [];
  if (!record(value) || typeof value.slot !== "string" || value.slot.length === 0 || !record(value.package) || typeof value.package.id !== "string" || !ID.test(value.package.id) || !isValidVersion(value.package.version) || typeof value.package.digest !== "string" || !DIGEST.test(value.package.digest) || typeof value.contribution !== "string" || value.contribution.length === 0 || !Number.isSafeInteger(value.generation) || value.generation < 0 || !["staged", "active", "failed", "inactive"].includes(value.state)) issue(issues, "MANIFEST_SLOT_BINDING", "$", "is not a valid SlotBinding");
  return result(value, issues);
}

export function validateInstalledPackage(value: unknown): ValidationResult<InstalledPackage> {
  const issues: ValidationIssue[] = [];
  if (!record(value)) {
    issue(issues, "PERSISTENCE_INSTALL_INDEX", "$", "must be an object");
    return result(value, issues);
  }
  const manifest = validateSkinManifest(value.manifest);
  if (!manifest.ok) issues.push(...manifest.issues.map((entry) => ({...entry, path: `$.manifest${entry.path.slice(1)}`})));
  if (typeof value.versionPath !== "string" || value.versionPath.length === 0) issue(issues, "PERSISTENCE_INSTALL_PATH", "$.versionPath", "must be a non-empty path");
  if (typeof value.digest !== "string" || !DIGEST.test(value.digest)) issue(issues, "PERSISTENCE_INSTALL_DIGEST", "$.digest", "must be a sha256 digest");
  if (!["local", "embedded", "remote"].includes(value.source)) issue(issues, "PERSISTENCE_INSTALL_SOURCE", "$.source", "must be local, embedded or remote");
  if (typeof value.origin !== "string" || value.origin.length === 0) issue(issues, "PERSISTENCE_INSTALL_ORIGIN", "$.origin", "must be a non-empty string");
  if (value.archiveDigest !== undefined && !DIGEST.test(String(value.archiveDigest))) issue(issues, "PERSISTENCE_INSTALL_DIGEST", "$.archiveDigest", "must be a sha256 digest");
  if (value.signature !== undefined) {
    if (!record(value.signature) || typeof value.signature.algorithm !== "string" || value.signature.algorithm.length === 0 || typeof value.signature.value !== "string" || value.signature.value.length === 0) {
      issue(issues, "PERSISTENCE_INSTALL_SIGNATURE", "$.signature", "must declare an algorithm and a value");
    }
  }
  if (value.refCount !== undefined && (!Number.isSafeInteger(value.refCount) || (value.refCount as number) < 0)) issue(issues, "PERSISTENCE_INSTALL_REFCOUNT", "$.refCount", "must be a non-negative integer");
  if (value.official !== undefined && typeof value.official !== "boolean") issue(issues, "PERSISTENCE_INSTALL_OFFICIAL", "$.official", "must be a boolean");
  return result(value, issues);
}

export function validateFaultEvent(value: unknown): ValidationResult<FaultEvent> {
  const issues: ValidationIssue[] = [];
  if (!record(value)) {
    issue(issues, "MANIFEST_FAULT_EVENT", "$", "must be an object");
    return result(value, issues);
  }
  if (!ISO_DATE.test(String(value.timestamp))) issue(issues, "MANIFEST_FAULT_EVENT_TIMESTAMP", "$.timestamp", "must be an ISO-8601 UTC instant");
  if (!["warning", "error", "fatal"].includes(value.severity)) issue(issues, "MANIFEST_FAULT_EVENT_SEVERITY", "$.severity", "must be warning, error or fatal");
  if (typeof value.errorCode !== "string" || !ERROR_CODE.test(value.errorCode)) issue(issues, "MANIFEST_FAULT_EVENT_ERROR_CODE", "$.errorCode", `must be one of ${ERROR_CATEGORIES.join(", ")} followed by an underscore-separated suffix`);
  if (typeof value.message !== "string") issue(issues, "MANIFEST_FAULT_EVENT_MESSAGE", "$.message", "must be a string");
  if (typeof value.correlationId !== "string" || value.correlationId.length === 0) issue(issues, "MANIFEST_FAULT_EVENT_CORRELATION_ID", "$.correlationId", "must be a non-empty string");
  if (!Number.isSafeInteger(value.generation) || value.generation < 0) issue(issues, "MANIFEST_FAULT_EVENT_GENERATION", "$.generation", "must be a non-negative integer");
  if (typeof value.regionOrSlot !== "string" || value.regionOrSlot.length === 0) issue(issues, "MANIFEST_FAULT_EVENT_REGION_OR_SLOT", "$.regionOrSlot", "must be a non-empty string");
  if (typeof value.lifecycleStage !== "string" || value.lifecycleStage.length === 0) issue(issues, "MANIFEST_FAULT_EVENT_STAGE", "$.lifecycleStage", "must be a non-empty string");
  if (!["official", "third-party"].includes(value.source)) issue(issues, "MANIFEST_FAULT_EVENT_SOURCE", "$.source", "must be official or third-party");
  if (typeof value.recoverable !== "boolean") issue(issues, "MANIFEST_FAULT_EVENT_RECOVERABLE", "$.recoverable", "must be a boolean");
  if (typeof value.recoveryAction !== "string" || value.recoveryAction.length === 0) issue(issues, "MANIFEST_FAULT_EVENT_RECOVERY_ACTION", "$.recoveryAction", "must be a non-empty string");
  if (typeof value.bindingState !== "string" || value.bindingState.length === 0) issue(issues, "MANIFEST_FAULT_EVENT_BINDING_STATE", "$.bindingState", "must be a non-empty string");
  const identity = [value.packageId, value.packageVersion, value.packageDigest].filter((part) => part !== undefined);
  if (identity.length > 0) {
    if (identity.length !== 3) issue(issues, "MANIFEST_FAULT_EVENT_PACKAGE", "$", "must carry packageId, packageVersion and packageDigest together");
    else {
      if (!ID.test(String(value.packageId))) issue(issues, "MANIFEST_FAULT_EVENT_PACKAGE", "$.packageId", "must be a lowercase identifier");
      if (!isValidVersion(value.packageVersion)) issue(issues, "MANIFEST_FAULT_EVENT_PACKAGE", "$.packageVersion", "must be SemVer");
      if (!DIGEST.test(String(value.packageDigest))) issue(issues, "MANIFEST_FAULT_EVENT_PACKAGE", "$.packageDigest", "must be a sha256 digest");
    }
  }
  if (value.control !== undefined && (typeof value.control !== "string" || value.control.length === 0)) issue(issues, "MANIFEST_FAULT_EVENT_CONTROL", "$.control", "must be a non-empty string");
  if (value.detail !== undefined && !record(value.detail)) issue(issues, "MANIFEST_FAULT_EVENT_DETAIL", "$.detail", "must be an object");
  return result(value, issues);
}

export function validateDisposeReport(value: unknown): ValidationResult<DisposeReport> {
  const issues: ValidationIssue[] = [];
  if (!record(value)) {
    issue(issues, "MANIFEST_DISPOSE_REPORT", "$", "must be an object");
    return result(value, issues);
  }
  if (!Number.isSafeInteger(value.generation) || value.generation < 0) issue(issues, "MANIFEST_DISPOSE_REPORT_GENERATION", "$.generation", "must be a non-negative integer");
  if (typeof value.slot !== "string" || value.slot.length === 0) issue(issues, "MANIFEST_DISPOSE_REPORT_SLOT", "$.slot", "must be a non-empty string");
  if (!Number.isSafeInteger(value.attempted) || value.attempted < 0) issue(issues, "MANIFEST_DISPOSE_REPORT_ATTEMPTED", "$.attempted", "must be a non-negative integer");
  if (!Number.isSafeInteger(value.released) || value.released < 0) issue(issues, "MANIFEST_DISPOSE_REPORT_RELEASED", "$.released", "must be a non-negative integer");
  if (!strings(value.remaining)) issue(issues, "MANIFEST_DISPOSE_REPORT_REMAINING", "$.remaining", "must be a string array");
  if (!strings(value.errors)) issue(issues, "MANIFEST_DISPOSE_REPORT_ERRORS", "$.errors", "must be a string array");
  if (typeof value.timedOut !== "boolean") issue(issues, "MANIFEST_DISPOSE_REPORT_TIMED_OUT", "$.timedOut", "must be a boolean");
  if (!ISO_DATE.test(String(value.completedAt))) issue(issues, "MANIFEST_DISPOSE_REPORT_COMPLETED_AT", "$.completedAt", "must be an ISO-8601 UTC instant");
  return result(value, issues);
}
