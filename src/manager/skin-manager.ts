import {mkdir} from "node:fs/promises";
import {join} from "node:path";

import {LIFECYCLE_DEADLINES} from "../contracts/constants.ts";
import type {BindingGeneration, FaultEvent, HostProfile, InstalledPackage, SlotBinding} from "../contracts/models.ts";
import {isErrorCode, toFaultCode, validateHostProfile, validateSkinManifest} from "../contracts/validation.ts";
import {ArtifactError, loadArtifact} from "../artifact/load.ts";
import {InstallError, PackageInstaller} from "../installer/package-installer.ts";
import {CatalogError, PackageCatalog} from "../catalog/package-catalog.ts";
import {ResolutionError, resolvePackage} from "../resolver/package-resolver.ts";
import {BindingStore} from "../bindings/binding-store.ts";
import {DiagnosticStore} from "../diagnostics/diagnostic-store.ts";
import {StructuredLog} from "../diagnostics/structured-log.ts";
import {SlotTransactionCoordinator, TransactionStageError} from "../transactions/slot-transaction-coordinator.ts";
import type {SlotTransactionContext, SlotTransactionResult} from "../transactions/slot-transaction-coordinator.ts";
import {ForceEnableController} from "../transactions/force-enable.ts";
import type {ForceEnableRequest, PendingForceEnable} from "../transactions/force-enable.ts";

export interface SlotSelection {
  slot: string;
  packageId: string;
  version: string;
  contribution: string;
}

export interface SkinManagerOptions {
  stateDirectory: string;
  installRoot: string;
  profile: HostProfile;
  managerVersion: string;
  defaultPackage?: {artifactPath: string; digest: string};
  transactionTimeoutMs?: number;
  log?: {maxFileBytes?: number; retentionDays?: number; basename?: string};
  clock?: () => Date;
}

export interface ManagerStatus {
  generation: number;
  profile: {id: string; version: string};
  bindings: Record<string, SlotBinding>;
  installed: {id: string; version: string; digest: string; source: string; official: boolean}[];
}

export type SlotOutcome =
  | {slot: string; state: "active"; binding: SlotBinding; disposeErrors: string[]}
  | {slot: string; state: "failed"; binding: SlotBinding; fault: FaultEvent; error: Error};

export interface ApplyOutcome {
  generation: number;
  slots: SlotOutcome[];
}

export interface ImportOutcome {
  installed: InstalledPackage;
  alreadyInstalled: boolean;
  verifiedFiles: number;
  resolution: {id: string; version: string; digest: string}[];
  fallback: {id: string; version: string; digest: string};
}

export class ManagerError extends Error {
  readonly code: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ManagerError";
    this.code = code;
  }
}

const STAGES = new Set(["inspect", "resolve", "verify", "prepare", "preload", "activate", "health", "commit", "dispose", "recovery", "runtime"]);

// docs/error-codes.md assigns a category per failure kind, so a stage name cannot simply be pasted after
// "ACTIVATE_": a health probe that hung must be TIMEOUT_HEALTH_CHECK, and one that answered "no" must be
// HEALTH_CHECK, or an operator grepping for HEALTH_ finds nothing while the skin is visibly broken.
const STAGE_FAILURES: Record<string, {code: string; timeout: string; stage: string}> = {
  generation: {code: "PREPARE_STALE_GENERATION", timeout: "TIMEOUT_STALE_GENERATION", stage: "prepare"},
  prepare: {code: "PREPARE_CONTEXT", timeout: "TIMEOUT_CONTEXT", stage: "prepare"},
  preload: {code: "PREPARE_PRELOAD", timeout: "TIMEOUT_PRELOAD", stage: "preload"},
  activate: {code: "ACTIVATE_MOUNT", timeout: "TIMEOUT_MOUNT", stage: "activate"},
  health: {code: "HEALTH_CHECK", timeout: "TIMEOUT_HEALTH_CHECK", stage: "health"},
  commit: {code: "ACTIVATE_COMMIT", timeout: "TIMEOUT_COMMIT", stage: "commit"},
  "commit-persistence": {code: "PERSISTENCE_COMMIT", timeout: "TIMEOUT_PERSISTENCE_COMMIT", stage: "commit"},
  rollback: {code: "DISPOSE_ROLLBACK", timeout: "TIMEOUT_ROLLBACK", stage: "dispose"},
  "dispose-old": {code: "DISPOSE_RESIDUE", timeout: "TIMEOUT_RESIDUE", stage: "dispose"}
};

const UNKNOWN_FAILURE = {code: "RUNTIME_FAILURE", timeout: "TIMEOUT_RUNTIME", stage: "runtime"};

function stageFailure(stage: string, timedOut: boolean): {code: string; stage: string} {
  const mapped = STAGE_FAILURES[stage] ?? UNKNOWN_FAILURE;
  return {code: timedOut ? mapped.timeout : mapped.code, stage: mapped.stage};
}

export class SkinManager {
  readonly profile: HostProfile;
  readonly bindings: BindingStore;
  readonly catalog: PackageCatalog;
  readonly installer: PackageInstaller;
  readonly diagnostics: DiagnosticStore;
  readonly log: StructuredLog;
  readonly transactions: SlotTransactionCoordinator;
  readonly forceEnable: ForceEnableController;
  readonly options: SkinManagerOptions;
  #generation = 0;
  #bindings: Record<string, SlotBinding> = {};
  #busy: Promise<unknown> = Promise.resolve();
  #clock: () => Date;

  private constructor(options: SkinManagerOptions) {
    this.options = options;
    this.profile = options.profile;
    this.#clock = options.clock ?? (() => new Date());
    this.bindings = new BindingStore(join(options.stateDirectory, "bindings"));
    this.catalog = new PackageCatalog({indexPath: join(options.stateDirectory, "install-index.json"), packagesRoot: options.installRoot});
    this.installer = new PackageInstaller(options.installRoot);
    this.diagnostics = new DiagnosticStore();
    this.log = new StructuredLog({
      directory: join(options.stateDirectory, "logs"),
      ...(options.log?.basename === undefined ? {} : {basename: options.log.basename}),
      ...(options.log?.maxFileBytes === undefined ? {} : {maxFileBytes: options.log.maxFileBytes}),
      ...(options.log?.retentionDays === undefined ? {} : {retentionDays: options.log.retentionDays}),
      now: this.#clock
    });
    this.transactions = new SlotTransactionCoordinator({timeoutMs: options.transactionTimeoutMs ?? LIFECYCLE_DEADLINES.activate});
    this.forceEnable = new ForceEnableController({
      timeoutMs: LIFECYCLE_DEADLINES.forceEnableConfirmation,
      now: () => this.#clock().getTime(),
      onRestoreFailure: (slot, error) => {
        this.record("error", "RECOVERY_FORCE_ENABLE_RESTORE_FAILED", slot, "recovery", `a force-enabled binding could not be restored: ${error.message}`, {recoverable: false, recoveryAction: "restart-host"});
      }
    });
  }

  // ADR 0002 section 1: a pending generation found at startup is abandoned; recovery resumes from committed state,
  // then previous-known-good, then the digest-locked default artifact.
  static async open(options: SkinManagerOptions): Promise<SkinManager> {
    const manager = new SkinManager(options);
    try {
      await manager.#start(options);
    } catch (error) {
      // The caller never receives the manager when startup fails, so this is the last chance to get the recorded
      // faults onto disk - otherwise the only evidence of why recovery died is in memory that is about to be
      // dropped. Flushing may not be the thing that replaces that evidence: an unusable log directory is a likely
      // co-cause of the very failure being reported here.
      await manager.flush().catch(() => undefined);
      throw error;
    }
    return manager;
  }

  async #start(options: SkinManagerOptions): Promise<void> {
    const profile = validateHostProfile(options.profile);
    if (!profile.ok) throw new ManagerError("MANIFEST_HOST_PROFILE", profile.issues.map((entry) => `${entry.path} ${entry.code}`).join("; "));
    await mkdir(options.stateDirectory, {recursive: true});
    await this.log.rotate().catch(() => false);
    const retention = await this.log.purge().catch((error: unknown) => ({removed: 0, failures: [`the retention scan failed: ${error instanceof Error ? error.message : String(error)}`]}));
    for (const failure of retention.failures) {
      this.record("warning", "PERSISTENCE_LOG_RETENTION", "manager", "recovery", `an expired log archive could not be removed: ${failure}`, {recoverable: true, recoveryAction: "free-disk-space"});
    }

    const index = await this.catalog.load();
    for (const entry of index.issues) {
      this.record("warning", "PERSISTENCE_INSTALL_INDEX", "manager", "recovery", `the install index was degraded: ${entry.path} ${entry.code}`);
    }
    const committed = await this.bindings.committed();
    if (committed.diagnostic !== undefined) {
      this.record("error", "PERSISTENCE_CORRUPT", "manager", "recovery", `committed bindings were unreadable and were preserved for inspection: ${committed.diagnostic}`);
    }
    const pending = await this.bindings.pending();
    if (pending.value !== undefined) {
      this.record("warning", "RECOVERY_PENDING_DISCARDED", "manager", "recovery", `generation ${pending.value.generation} was staged but never committed, so it was discarded`);
    }
    const recovered = await this.bindings.recover();
    this.#bindings = recovered.bindings;
    this.#generation = recovered.generation;
    if (committed.value === undefined && (await this.bindings.previous()).value !== undefined) {
      this.record("warning", "RECOVERY_FALLBACK_APPLIED", "manager", "recovery", "committed bindings were absent, so the newest previous-known-good generation was promoted");
    }

    if (options.defaultPackage !== undefined) {
      try {
        await this.importPackage(options.defaultPackage.artifactPath, {expectedDigest: options.defaultPackage.digest, source: "embedded"});
      } catch (error) {
        throw new ManagerError("RECOVERY_DEFAULT_UNAVAILABLE", `the digest-locked default skin could not be installed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await this.#bindToDefault();
    }
  }

  get generation(): number { return this.#generation; }

  status(): ManagerStatus {
    return {
      generation: this.#generation,
      profile: {id: this.profile.id, version: this.profile.version},
      bindings: structuredClone(this.#bindings),
      installed: this.catalog.list().map((item) => ({
        id: item.manifest.metadata.id,
        version: item.manifest.metadata.version,
        digest: item.digest,
        source: item.source,
        official: item.official === true
      }))
    };
  }

  async draft(): Promise<BindingGeneration | undefined> {
    return (await this.bindings.draft()).value;
  }

  async previousGenerations(): Promise<BindingGeneration[]> {
    return this.bindings.previousGenerations();
  }

  async quarantined(): Promise<{packageId: string; slot: string; reason: string}[]> {
    return (await this.bindings.quarantined()).map((entry) => ({packageId: entry.packageId, slot: entry.slot, reason: entry.reason}));
  }

  async importPackage(artifactPath: string, options: {expectedDigest?: string; source?: "local" | "embedded"; signature?: {algorithm: string; value: string; signer?: string}} = {}): Promise<ImportOutcome> {
    let loaded;
    try {
      loaded = await loadArtifact(artifactPath);
    } catch (error) {
      throw new ManagerError(error instanceof ArtifactError ? error.code : "MANIFEST_PARSE", error instanceof Error ? error.message : String(error));
    }
    let imported;
    try {
      imported = await this.installer.import(loaded, {...options, source: options.source ?? "local"});
    } catch (error) {
      throw new ManagerError(error instanceof InstallError ? error.code : "PERSISTENCE_WRITE_FAILED", error instanceof Error ? error.message : String(error));
    }
    let installed;
    try {
      installed = this.catalog.install(imported.installed);
    } catch (error) {
      throw new ManagerError(error instanceof CatalogError ? error.code : "PERSISTENCE_INSTALL_INDEX", error instanceof Error ? error.message : String(error));
    }
    await this.catalog.save();
    try {
      const resolution = this.resolve(installed.manifest);
      return {
        installed,
        alreadyInstalled: imported.alreadyInstalled,
        verifiedFiles: imported.verifiedFiles,
        resolution: resolution.packages.map((item) => ({id: item.manifest.metadata.id, version: item.manifest.metadata.version, digest: item.digest})),
        fallback: resolution.fallback
      };
    } catch (error) {
      if (error instanceof ResolutionError) {
        this.record("warning", error.code, "manager", "resolve", `${installed.manifest.metadata.id} installed but cannot be resolved: ${error.message}`);
      }
      throw error;
    }
  }

  resolve(root: InstalledPackage["manifest"]): ReturnType<typeof resolvePackage> {
    return resolvePackage(root, this.catalog.list(), {
      profile: this.profile,
      managerVersion: this.options.managerVersion,
      hostVersion: this.profile.version
    });
  }

  // An explicit user choice only; nothing here switches a slot (ADR 0002 section 7).
  select(selections: SlotSelection[]): Promise<BindingGeneration> {
    return this.#exclusive(() => this.#select(selections));
  }

  async #select(selections: SlotSelection[]): Promise<BindingGeneration> {
    const generation = this.#generation + 1;
    const bindings: Record<string, SlotBinding> = {...this.#bindings};
    for (const selection of selections) {
      const rejection = await this.#verify(selection);
      if (rejection !== undefined) {
        const fault = this.record("error", rejection.code, selection.slot, "verify", rejection.message, {
          packageId: selection.packageId,
          packageVersion: selection.version,
          recoverable: true,
          recoveryAction: "choose-another-skin",
          bindingState: "failed"
        });
        throw new ManagerError(rejection.code, fault.message);
      }
      const item = this.catalog.get(selection.packageId, selection.version)!;
      bindings[selection.slot] = {
        slot: selection.slot,
        package: {id: item.manifest.metadata.id, version: item.manifest.metadata.version, digest: item.digest},
        contribution: selection.contribution,
        generation,
        state: "staged"
      };
    }
    const draft = {generation, bindings};
    await this.bindings.selectDraft(draft);
    return structuredClone(draft);
  }

  async clearDraft(): Promise<void> {
    await this.bindings.selectDraft({generation: this.#generation, bindings: structuredClone(this.#bindings)});
  }

  // The host supplies the transaction contexts; the manager owns ordering, persistence, and rollback. Slots are
  // applied sequentially inside one call, and the whole call holds the manager lock: two overlapping `apply()`
  // runs each merge from a snapshot taken before the other landed, so the later write deletes the first one's
  // slot from `committed.json` while both report success.
  apply(contexts: (binding: SlotBinding) => SlotTransactionContext[]): Promise<ApplyOutcome> {
    return this.#exclusive(() => this.#apply(contexts));
  }

  async #apply(contexts: (binding: SlotBinding) => SlotTransactionContext[]): Promise<ApplyOutcome> {
    const draft = (await this.bindings.draft()).value;
    const candidates = Object.entries(draft?.bindings ?? {}).filter(([slot, binding]) => this.#bindings[slot]?.package.digest !== binding.package.digest || this.#bindings[slot]?.contribution !== binding.contribution);
    if (draft === undefined || candidates.length === 0) {
      await this.bindings.discardPending();
      return {generation: this.#generation, slots: []};
    }
    await this.bindings.stage(draft);
    const slots: SlotOutcome[] = [];
    for (const [slot, candidate] of candidates) {
      const rejection = await this.#verify({slot, packageId: candidate.package.id, version: candidate.package.version, contribution: candidate.contribution});
      if (rejection !== undefined) {
        slots.push(this.#fail(slot, candidate, rejection.code, "verify", rejection.message, "choose-another-skin"));
        continue;
      }
      const previous = this.#bindings[slot];
      const binding: SlotBinding = {...candidate, generation: ++this.#generation, state: "staged"};
      let result: SlotTransactionResult;
      try {
        result = await this.transactions.switch({
          slot,
          binding,
          contexts: contexts(binding),
          ...(previous === undefined ? {} : {previous: {binding: previous}}),
          persist: async (committed) => {
            await this.bindings.commit({generation: this.#generation, bindings: {...this.#bindings, [slot]: committed}});
          }
        });
      } catch (error) {
        // A throw that is not a staged failure says nothing about which stage broke - it can be the host's own
        // context factory - so it is reported under RUNTIME_* rather than pinned on a mount that may have
        // succeeded. Claiming ACTIVATE_* here sends an operator to look at the wrong hook.
        const staged = error instanceof TransactionStageError;
        const failure = stageFailure(staged ? error.stage : "runtime", staged && error.timedOut);
        const detail = error instanceof Error ? error.message : String(error);
        // A stage that was abandoned after its abort was ignored is the one failure the rollback cannot be
        // trusted to have undone, so the line has to say so rather than just reporting a timeout.
        const message = staged && error.abandoned ? `${detail}; ${binding.package.id} had still not stopped when its abort was given up on, so an effect may land on ${slot} after the restore` : detail;
        slots.push(this.#fail(slot, binding, failure.code, failure.stage, message, "restore-default"));
        continue;
      }
      this.#bindings = {...this.#bindings, [slot]: result.binding};
      // The candidate is mounted and its record is durable by this point. Everything below is bookkeeping about
      // the generation it replaced, and a failure there must not report the switch itself as failed.
      const disposeErrors = [...result.disposeErrors];
      try {
        for (const message of disposeErrors) {
          await this.bindings.quarantine(binding.package.id, slot, "DISPOSE_RESIDUE");
          this.record("error", "DISPOSE_RESIDUE", slot, "dispose", `${binding.package.id} left effects behind after being replaced: ${message}`, {
            packageId: binding.package.id,
            packageVersion: binding.package.version,
            packageDigest: binding.package.digest,
            recoverable: true,
            recoveryAction: "disable-package",
            bindingState: "failed"
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        disposeErrors.push(`the residue could not be quarantined: ${message}`);
        this.record("error", "PERSISTENCE_QUARANTINE", slot, "dispose", `${binding.package.id} left effects behind and could not be quarantined: ${message}`, {
          packageId: binding.package.id,
          packageVersion: binding.package.version,
          packageDigest: binding.package.digest,
          recoverable: true,
          recoveryAction: "disable-package"
        });
      }
      slots.push({slot, state: "active", binding: result.binding, disposeErrors});
    }
    await this.bindings.discardPending();
    await this.clearDraft();
    return {generation: this.#generation, slots};
  }

  rollback(): Promise<BindingGeneration> {
    return this.#exclusive(() => this.#rollback());
  }

  async #rollback(): Promise<BindingGeneration> {
    const previous = (await this.bindings.previous()).value;
    if (previous === undefined) throw new ManagerError("RECOVERY_HISTORY_UNAVAILABLE", "there is no previous-known-good generation to roll back to");
    await this.bindings.commit(previous);
    this.#bindings = structuredClone(previous.bindings);
    this.#generation = Math.max(this.#generation, previous.generation);
    this.record("warning", "RECOVERY_ROLLBACK_APPLIED", "manager", "recovery", `bindings were rolled back to generation ${previous.generation}`);
    return structuredClone(previous);
  }

  disable(slot: string, packageId: string, reason = "CAPABILITY_USER_DISABLED"): Promise<void> {
    return this.#exclusive(() => this.#disable(slot, packageId, reason));
  }

  async #disable(slot: string, packageId: string, reason: string): Promise<void> {
    if (!isErrorCode(reason)) throw new ManagerError("PERSISTENCE_QUARANTINE_REASON", `${JSON.stringify(reason)} is not a stable error code`);
    await this.bindings.quarantine(packageId, slot, reason);
    this.record("warning", "CAPABILITY_USER_DISABLED", slot, "commit", `${packageId} was disabled for ${slot}`, {packageId, recoverable: true, recoveryAction: "enable-package"});
  }

  async enable(slot: string, packageId: string): Promise<boolean> {
    return this.bindings.releaseQuarantine(packageId, slot);
  }

  async beginForceEnable(request: ForceEnableRequest): Promise<PendingForceEnable> {
    return this.forceEnable.begin({...request, restore: async () => {
      await request.restore();
      await this.persist();
    }});
  }

  async keepForceEnable(slot: string): Promise<"kept" | "restored"> {
    const outcome = await this.forceEnable.keep(slot);
    if (outcome === "kept") await this.persist();
    return outcome;
  }

  async expireForceEnable(slot: string): Promise<void> {
    await this.forceEnable.expire(slot);
  }

  // ADR 0002 section 1: anything an active, pending, previous-known-good, or default record refers to survives.
  async collectGarbage(): Promise<InstalledPackage[]> {
    const pinned = await this.#referencedCoordinates();
    const removed = this.catalog.collectGarbage(pinned);
    for (const item of removed) {
      await this.installer.remove(item.manifest.metadata.id, item.manifest.metadata.version, item.digest);
    }
    if (removed.length > 0) await this.catalog.save();
    return removed;
  }

  async #referencedCoordinates(): Promise<Set<string>> {
    const keys = new Set<string>();
    const coordinate = (binding: SlotBinding): string => `${binding.package.id}@${binding.package.version}`;
    for (const binding of Object.values(this.#bindings)) keys.add(coordinate(binding));
    for (const generation of [...await this.bindings.previousGenerations(), (await this.bindings.pending()).value, (await this.bindings.draft()).value]) {
      for (const binding of Object.values(generation?.bindings ?? {})) keys.add(coordinate(binding));
    }
    keys.add(`${this.profile.fallbackSkin.id}@${this.profile.fallbackSkin.version}`);
    return keys;
  }

  persist(): Promise<void> {
    return this.#exclusive(() => this.#persist());
  }

  async #persist(): Promise<void> {
    await this.bindings.commit({generation: this.#generation, bindings: structuredClone(this.#bindings)});
    await this.catalog.save();
  }

  async flush(): Promise<void> {
    await this.log.flush();
  }

  record(severity: FaultEvent["severity"], errorCode: string, regionOrSlot: string, lifecycleStage: string, message: string, extra: Partial<FaultEvent> = {}): FaultEvent {
    const timestamp = this.#clock().toISOString();
    // A code from the artifact or validator layer that is not a fault code is folded onto its category here and
    // named in the message, instead of being persisted verbatim and rejected downstream: an operator reading the
    // log has to find the same line they would find by grepping the thrown error.
    const code = toFaultCode(errorCode);
    const text = code === errorCode ? message : `${message} (${errorCode})`;
    const identity = [extra.packageId, extra.packageVersion, extra.packageDigest];
    const complete = identity.every((part) => typeof part === "string" && part.length > 0);
    const fault: FaultEvent = {
      timestamp,
      severity,
      errorCode: code,
      message: text,
      correlationId: extra.correlationId ?? `${code}-${regionOrSlot}-${this.#generation}`,
      generation: extra.generation ?? this.#generation,
      regionOrSlot,
      lifecycleStage: STAGES.has(lifecycleStage) ? lifecycleStage : "recovery",
      source: extra.source ?? "third-party",
      recoverable: extra.recoverable ?? true,
      recoveryAction: extra.recoveryAction ?? "none",
      bindingState: extra.bindingState ?? "inactive",
      ...(complete ? {packageId: identity[0], packageVersion: identity[1], packageDigest: identity[2]} : {}),
      ...(extra.control === undefined ? {} : {control: extra.control}),
      ...(extra.detail === undefined ? {} : {detail: extra.detail})
    };
    const outcome = this.diagnostics.record(fault);
    if (outcome.recorded) void this.log.write(outcome.fault);
    else void this.log.write({timestamp, level: "error", errorCode: "RECOVERY_DIAGNOSTIC_UNCLASSIFIED", message: `${message} (${outcome.issues.map((entry) => entry.code).join(",")})`});
    return fault;
  }

  // One manager owns one set of slot files, so every read-modify-write of `#bindings` takes this turn: the lock
  // is the only thing that makes "merge into the current bindings" mean "into the bindings as they are now".
  // A rejected task is not allowed to strand the lock, or one failed switch would deadlocks every later call.
  #exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#busy.then(run, run);
    this.#busy = next.then(() => undefined, () => undefined);
    return next;
  }

  async #verify(selection: SlotSelection): Promise<{code: string; message: string} | undefined> {
    if (!this.profile.slots.some((slot) => slot.id === selection.slot)) return {code: "COMPATIBILITY_SLOT", message: `${selection.slot} is not offered by the host profile`};
    const item = this.catalog.get(selection.packageId, selection.version);
    if (!item) return {code: "DEPENDENCY_MISSING", message: `${selection.packageId}@${selection.version} is not installed`};
    const quarantined = await this.bindings.isQuarantined(selection.packageId, selection.slot);
    if (quarantined !== undefined) return {code: quarantined.reason, message: `${selection.packageId} is quarantined for ${selection.slot} (${quarantined.reason}), enable it before switching back`};
    const validation = validateSkinManifest(item.manifest, {profile: this.profile});
    if (!validation.ok) return {code: validation.issues[0]?.code ?? "MANIFEST_INVALID", message: `${selection.packageId}: ${validation.issues.map((entry) => `${entry.path} ${entry.code}`).join("; ")}`};
    const contribution = item.manifest.contributions.find((candidate) => candidate.id === selection.contribution);
    if (!contribution) return {code: "MANIFEST_CONTRIBUTION", message: `${selection.packageId} declares no contribution ${selection.contribution}`};
    if (contribution.slot !== selection.slot) return {code: "COMPATIBILITY_SLOT", message: `contribution ${contribution.id} targets ${contribution.slot}, not ${selection.slot}`};
    return undefined;
  }

  #fail(slot: string, binding: SlotBinding, code: string, lifecycleStage: string, message: string, recoveryAction: string): SlotOutcome {
    const fault = this.record("error", code, slot, lifecycleStage, message, {
      packageId: binding.package.id,
      packageVersion: binding.package.version,
      packageDigest: binding.package.digest,
      recoverable: true,
      recoveryAction,
      bindingState: "failed"
    });
    return {slot, state: "failed", binding, fault, error: new Error(`${code}: ${message}`)};
  }

  // The default is non-forceable and seeds only the slots that carry no binding yet, so a restart recovers the
  // user's choices and falls back to the shipped skin for the rest (ADR 0002 section 3).
  async #bindToDefault(): Promise<void> {
    const fallback = this.profile.fallbackSkin;
    const item = this.catalog.get(fallback.id, fallback.version);
    if (!item) throw new ManagerError("RECOVERY_DEFAULT_UNAVAILABLE", `${fallback.id}@${fallback.version} is not installed`);
    const bindings: Record<string, SlotBinding> = {...this.#bindings};
    let seeded = 0;
    for (const slot of this.profile.slots) {
      if (bindings[slot.id] !== undefined) continue;
      const contribution = item.manifest.contributions.find((candidate) => candidate.slot === slot.id);
      if (!contribution) continue;
      bindings[slot.id] = {
        slot: slot.id,
        package: {id: item.manifest.metadata.id, version: item.manifest.metadata.version, digest: item.digest},
        contribution: contribution.id,
        generation: this.#generation,
        state: "active"
      };
      seeded += 1;
    }
    if (Object.keys(bindings).length === 0) throw new ManagerError("RECOVERY_DEFAULT_INVALID", `${fallback.id} contributes to no slot in this profile`);
    this.#bindings = bindings;
    if (seeded > 0) await this.bindings.commit({generation: this.#generation, bindings});
  }
}
