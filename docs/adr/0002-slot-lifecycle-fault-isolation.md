# ADR 0002: Slot lifecycle, fault isolation, and rollback

Date: 2026-09-20
Status: Accepted for v6 stage 0
Owner: dsh-ui-skin-manager maintainers (state machine, persistence, diagnostics, and recovery)

## Context

A Skin may provide arbitrary component logic and styles to one or more slots. Content freedom does not remove the manager's obligation to isolate failure and undo observable effects. The switching unit is one slot, not an entire shell or package. Different slots may bind different packages and generations, while a single slot must never display a half-old/half-new mixture.

This ADR freezes the manager lifecycle and recovery protocol before any loader/runtime implementation is written.

## Decision

### 1. Persistent records and ownership

| Record | Required content | Owner |
| --- | --- | --- |
| `InstallIndex` | package coordinate, origin, digest, optional signature/provenance, extracted path, references, quarantine state | manager |
| `SelectedDraft` | unapplied user choices by slot | manager settings layer |
| `CommittedBinding` | exactly one committed generation; slot to package/version/digest/contribution mapping | manager |
| `PreviousKnownGood` | two most recent complete, healthy, digest-verified generations | manager |
| `PendingGeneration` | candidate generation and transaction journal; never active after restart | manager |
| `DisabledRecord` | package x slot disable/quarantine reason and last fault | manager |
| `FaultEvent` | structured fault fields defined below | manager |
| `DisposeReport` | effect-ledger cleanup result defined below | manager |

All persistent writes use a same-filesystem temporary file, flush, and atomic rename. Corrupt state is preserved for diagnostics and is not silently reset. A `PendingGeneration` found at startup is abandoned and disposed; recovery resumes from `CommittedBinding`, then `PreviousKnownGood`, then the embedded and digest-locked `system.default` artifact, and finally the host embedded fallback.

The manager retains exactly two previous-known-good generations in addition to the active generation and the non-removable bundled default needed for recovery. Artifacts referenced by active, pending, previous-known-good, or default records cannot be garbage-collected.

### 2. Per-slot state machine

A candidate slot binding follows this exact sequence:

`discover -> inspect -> resolve -> verify -> prepare -> preload -> activate(staged) -> health -> commit -> active`

Normal removal follows:

`active -> deactivate -> dispose -> inactive`

Rules:

1. `discover` locates a package but grants no trust.
2. `inspect` parses the envelope without executing package code.
3. `resolve` selects exact package, dependency, profile, dsh, capability, slot, and contribution versions.
4. `verify` enforces schema, SemVer, digest, optional signature/catalog provenance, normalized path inventory, declared assets, and duplicate checks.
5. `prepare` creates an isolated transaction and effect ledger without changing the current active binding.
6. `preload` loads candidate modules/assets into the staged context.
7. `activate(staged)` mounts the candidate only in the staged slot context.
8. `health` waits for required CSS/theme/slot registration/component readiness and receives all required context acknowledgements.
9. `commit` atomically publishes the new slot generation and persists `CommittedBinding`.
10. Only after commit may the old contribution enter `deactivate -> dispose`.

The slot's DOM contribution, style/link set, theme layer, slot registration, capability bindings, generation guard, and persisted binding must all refer to one package digest and generation. A stale callback is blocked by its generation guard and cannot mutate a newer generation.

### 3. Failure transitions

- Failure in `inspect`, `resolve`, `verify`, `prepare`, `preload`, or `health`: current active remains untouched; staged effects are disposed in reverse registration order; candidate becomes `failed`.
- Failure during staged activation: dispose every registered candidate effect in reverse order; restore the previous staged view; do not persist the candidate.
- Failure while committing: roll back the candidate publication and restore the complete previous slot generation; partial persisted state is invalid.
- Runtime failure after commit: isolate the affected slot and display stable error UI. If the slot's default contribution is healthy, roll back only that slot; otherwise roll back the complete generation to previous-known-good.
- Abnormal process exit with pending state: ignore the pending candidate at next start and recover committed state. The pending candidate never becomes active by inference.
- A failure in one slot does not cancel unrelated slot transactions or unmount their active contributions.

`system.default` is non-forceable and cannot be uninstalled into a state with no recovery artifact. If manager or default recovery cannot run, the host embedded fallback remains available for diagnostics and repair.

### 4. Timeout, abort, and disposer protocol

Each slot transaction owns one `AbortController`; unrelated slots never share it. Lifecycle hooks receive the slot `AbortSignal` and bounded deadlines. The default v1 deadlines are:

| Stage | Deadline | Owner |
| --- | --- | --- |
| `prepare` + `preload` | 10 seconds | manager policy |
| `activate(staged)` | 10 seconds | manager policy |
| `health` | 10 seconds | manager policy |
| `deactivate` + `dispose` | 10 seconds | manager policy |
| forced compatibility confirmation | 30 seconds | product policy |

A package may request a shorter deadline but cannot increase these maxima. Timeout aborts the candidate and emits a stage-specific `FaultEvent`. Timeout does not authorize abandoning tracked effects.

Every staged context has an effect ledger. The manager or adapter records timers, animation frames, event listeners, observers, workers, style/link nodes, theme layers, slot registrations, portals, capability leases, and package-provided disposers. Disposal is idempotent: repeated calls produce the same terminal state and never recreate effects. Effects are released in reverse registration order. The `DisposeReport` contains `generation`, `slot`, `attempted`, `released`, `remaining`, `errors`, `timedOut`, and `completedAt`. A non-empty `remaining` list fails cleanup and quarantines that package x slot binding. The manager then rebuilds the isolated slot context before reuse; it does not report success by hiding a residual effect.

### 5. Fault event and user-visible recovery

A `FaultEvent` requires:

- `timestamp`, `severity`, `errorCode`, `message`, and `correlationId`;
- `packageId`, `packageVersion`, `packageDigest`, and `generation` when known;
- `regionOrSlot`, optional `control`, and `lifecycleStage`;
- `source` (`official` or `third-party`) and a redacted diagnostic detail object;
- `recoverable`, `recoveryAction`, and the resulting binding state.

Stable error-code categories are `MANIFEST`, `COMPATIBILITY`, `INTEGRITY`, `PATH`, `DEPENDENCY`, `CAPABILITY`, `PREPARE`, `ACTIVATE`, `HEALTH`, `TIMEOUT`, `RUNTIME`, `DISPOSE`, `PERSISTENCE`, and `RECOVERY`. Concrete codes are category-prefixed and additive within contract v1.

The failed slot shows a stable error surface instead of blank CSS or silent failure. It provides actions to view logs, copy redacted diagnostics, retry, disable the package for that slot, restore default, and view package source. Third-party failures are labeled as third-party content not covered by official guarantees. Other slots and host window controls remain interactive.

### 6. Structured log retention and redaction

The manager writes structured JSON lines. Logs rotate at 16 MiB per file and are retained for 30 days. Rotation may additionally occur at application start or day boundary, but must not shorten the 30-day retention window. Files older than 30 days are removed by age; deletion failures are logged without blocking startup. Exported diagnostics contain a bounded selection, not every retained file by default.

Fields containing filesystem roots, usernames, home directories, tokens, authorization headers, query credentials, user prompts/content, or arbitrary package payloads are redacted or replaced by stable hashes before persistence. Package IDs, versions, digests, slot IDs, error codes, lifecycle stages, generation numbers, and correlation IDs remain visible. The host owns platform log access and copy/open capabilities; the manager owns event structure, rotation, retention, and redaction policy.

### 7. Manual switching and force-enable flow

v6 supports only user-initiated import, explicit per-slot selection, and explicit apply. It does not implement a file watcher, background download, automatic update, or automatic switch.

An incompatible non-default contribution may be force-enabled only through the visible settings action. JSON, path, asset, and digest failures are never forceable. Before staging, the manager saves the original slot binding. After staged activation it starts a 30-second confirmation window with `keep enabled` and `restore disabled`. Keeping commits the candidate. Restoring, timeout, crash, page disconnect, or application exit returns to the original binding and leaves the target disabled. Pending force state is never inferred to be active after restart.

### 8. Rejected alternatives

- Package-wide atomic switch: rejected because per-slot free composition is required.
- Dispose old before candidate health: rejected because it makes rollback destructive.
- Shared abort controller across slots: rejected because one failure would propagate.
- Silent empty-style fallback: rejected because it hides faults and can leave the host unusable.
- Best-effort untracked cleanup: rejected because arbitrary component logic requires an auditable effect ledger.
- Unlimited logs: rejected for disk safety; 16 MiB rotation and 30-day retention are fixed for v1.
- Automatic watcher/update in v6: rejected for this scope; only explicit user actions trigger switching.

## Conflict cleanup and replacement gates

No lifecycle tests currently exist in this repository. The old placeholder README did not specify transaction order, effect cleanup, fault UI, retention, or rollback. This ADR supersedes any implication that simple file replacement or upstream HMR is a product-level hot switch. Future removal of old tests, SKILL files, or specifications must name the conflicting assertion and replace it with lifecycle ordering, timeout/abort, idempotent disposal, fault isolation, persistence corruption, and rollback tests. Tests may not be weakened to accommodate an implementation.

## Consequences

A failed candidate cannot replace or corrupt the current active slot. Runtime failures remain visible and recoverable without taking down unrelated slots. The cost is explicit staged contexts, effect tracking, transaction persistence, and recovery testing; those are required architecture, not optional implementation details.

## Acceptance evidence

This ADR assigns owners and fixed values for every lifecycle, persistence, timeout, cleanup, diagnostic, retention, force-enable, and rollback field. It does not implement the runtime.
