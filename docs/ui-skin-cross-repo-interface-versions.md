# UI skin cross-repository interface versions

Status: Frozen for v6 stage 0
Last updated: 2026-09-20
Normative owners: listed per interface below

This table is the compatibility index for `dsh-ui-skin-manager`, `DSH-Desktop-EAC`, and `dsh-desktop-eac-default-skins`. Detailed semantics live in the accepted ADRs. An interface may change only through its owning repository's ADR and an atomic update to this table and all affected conformance tests. Application version, package version, schema version, host profile, dsh range, and artifact digest are independent axes.

## Version matrix

| Interface | Frozen version/value | Normative owner | Producer | Consumer | Compatibility and change rule |
| --- | --- | --- | --- | --- | --- |
| Manager public API | `dsh-ui-skin-manager@1` | manager | manager | EAC adapter | SemVer; breaking lifecycle or snapshot changes increment major |
| Skin manifest | `apiVersion: dsh.eac.ui-skin/v1`, `kind: SkinPackage` | manager | skin packages/default-skins | manager | Unknown higher version rejected before activation |
| Manifest JSON schema ID | `https://dsh-eac.github.io/schemas/ui-skin/v1/skin-package.schema.json` | manager | manager release | manager/default-skins/EAC CI | Immutable schema ID; corrected breaking semantics require `v2` |
| Package coordinate | `<metadata.id>@<metadata.version>#sha256:<64 lowercase hex>` | manager | package publisher/release | manager/EAC build lock | ID immutable per lineage; SemVer + exact digest identify bytes |
| Artifact digest policy | `sha256-v1`: manifest covers each payload file; external catalog/build lock/provenance sidecar covers canonical archive bytes | manager release owner | package release workflow | manager/EAC build | Mandatory; mismatch never forceable; archive digest is never self-embedded |
| Official container compatibility | `dshpack-ui-skin-container@1`: official EAC `.dshpack` may wrap exactly one declared `SkinPackage`; generic Feature Pack contents are not accepted as Skin payloads | EAC distribution owner + manager format owner | EAC Feature Pack packaging/default-skins release | manager/EAC | Outer pack metadata and digest are provenance only; inner SkinPackage schema, path, asset, capability, lifecycle, and trust gates remain mandatory |
| Signature/provenance policy | `provenance-v1`; signature optional | manager policy; publisher supplies evidence | release workflow | manager/UI | Missing signature allowed for third-party; self-declared official status ignored |
| Host profile | `dsh-desktop-eac-ui-skin-profile@^0.3.0` | EAC | EAC | manager/default-skins | `engines.hostProfile` range must match; breaking slot/capability changes increment major/minor as SemVer requires |
| Host capability registry | `dsh-eac-host-capabilities@1` | EAC | EAC | manager/packages | Only declared versioned capability IDs; additions are additive, semantic break increments major |
| Slot descriptor | `dsh-eac-slot-descriptor@1` | EAC | EAC HostProfile | manager/packages | Exact ID/kind/scope/props/mount/capability match; no fuzzy matching |
| Slot contribution | `dsh-eac-slot-contribution@1` | manager format owner; slot terms from EAC | package publisher | manager/EAC adapter | One target slot per item; duplicate/unknown/incompatible entries rejected |
| Skin context | `dsh-eac-skin-context@1` | manager + EAC capability owner | manager/EAC adapter | contribution | Frozen scoped object: props, declared capabilities, logger, AbortSignal; no private host objects |
| Active binding snapshot | `dsh-eac-active-binding-snapshot@1` | manager | manager | EAC | Exact generation/package/version/digest/contribution per slot; unsupported profile or stale generation rejected |
| Fault event | `dsh-eac-skin-fault@1` | manager | manager/EAC adapter | diagnostics UI/log export | Required fields and categories in ADR 0002; additive codes allowed, field removal requires major |
| Dispose report | `dsh-eac-dispose-report@1` | manager | manager/adapters | recovery/diagnostics | Non-empty `remaining` means cleanup failure and quarantine |
| Lifecycle protocol | `inspect -> resolve -> verify -> prepare -> preload -> activate(staged) -> health -> commit` (`lifecycle-v1`) | manager | manager | EAC adapter/packages | Order is normative; old active remains until commit; failure transitions in ADR 0002 |
| Persistence protocol | `dsh-eac-skin-state@1` | manager | manager | manager/EAC recovery | Atomic rename; pending never active; two previous-known-good generations retained |
| Resource channel | `eac-skin-resource@1` | EAC | EAC | WebView contributions | Inventory and digest bound; traversal/symlink escape/undeclared asset rejected |
| dsh public adapter | `eac-dsh-adapter@1` | EAC adapter owner | EAC | manager/packages | Explicit `engines.dsh` mappings; initial matrix includes `dsh-v0.1.5-rc.2` and `dsh-v0.1.6-alpha.2` |
| Default skin identity | `system.default@2.0.0` | default-skins source owner | default-skins release | manager/EAC | Non-forceable; exact digest locked by EAC build; source exists only in default-skins after cutover |
| Default legacy profile input | `dsh-desktop-eac-ui-skin-profile@^0.3` | EAC ADR 0009 | current EAC static package | migration tooling | Migration input only; SemVer-normalized to the equivalent frozen range `^0.3.0` during manager packaging |
| Logging policy | `skin-log-v1`: JSONL, 16 MiB rotation, 30-day retention | manager; platform access by EAC | manager/EAC adapter | diagnostics | Redaction mandatory before persistence; retention/size changes require policy update and tests |
| Force-enable protocol | `skin-force-enable@1`: 30-second confirmation | manager product policy | settings UI/manager | contribution binding | Never bypasses schema/path/asset/digest; timeout/crash/disconnect restores disabled binding |
| Default license policy | MIT, `Copyright (c) 2026 zouyuxuan122` | default-skins | default-skins | release/EAC bundle | `NOTICE` only for real obligations; no placeholder/empty NOTICE |
| Release provenance | `ui-skin-provenance@1` | publisher workflow; policy by manager | package release | EAC build/manager/UI | Includes source commit, workflow/run, builder, time, lock/digests, contract versions, artifact and digest |

## Frozen v1 data models

### `SkinManifest`

Owned by manager. Required fields:

- `apiVersion`, `kind`;
- `metadata.id`, `metadata.version`, `metadata.name`, `metadata.author`;
- `engines.manager`, `engines.hostProfile`, optional `engines.dsh`;
- non-empty `contributions`;
- complete `assets` inventory with a SHA-256 digest for every payload file;
- required per-file SHA-256 `integrity` map and optional signature/provenance references. The whole-archive SHA-256 is external because embedding it in the archive would be self-referential.

### `HostProfile` and `SlotDescriptor`

Owned by EAC. `HostProfile` requires `id`, `version`, `regions`, `slots`, `instanceKinds`, `zIndexPolicy`, `capabilities`, `dshAdapters`, and `fallbackSkin`.

Each `SlotDescriptor` requires `id`, `region`, `kind`, `scope`, `propsSchema`, `mountContract`, `zIndexPolicy`, `capabilities`, and `fallbackSkin`. The initial regions are `top-sidebar`, `bottom-sidebar`, `left-sidebar`, `right-sidebar`, `session`, and `overlay`. Initial instance kinds are `popup`, `dialog`, and `floating-window`.

### `SlotContribution`

Owned by manager format, with target terms owned by EAC. Required fields are `id`, `slot`, `entry`, `assets`, `requires.capabilities`, `requires.slotKind`, `requires.slotScope`, and `lifecycle.mount`, `lifecycle.health`, `lifecycle.unmount`; `style` is optional but inventory-bound.

### `SlotBinding` and `ActiveBindingSnapshot`

Owned by manager. A binding requires `slot`, `package.id`, `package.version`, `package.digest`, `contribution`, `generation`, and `state`. A snapshot requires its profile version, committed generation, complete bindings, resolved asset digests, and creation timestamp. EAC rejects incomplete, stale, unknown-slot, unsupported-profile, or digest-inconsistent snapshots.

### `FaultEvent`

Owned by manager. Required fields are `timestamp`, `severity`, `errorCode`, `message`, `correlationId`, `generation`, `regionOrSlot`, `lifecycleStage`, `source`, `recoverable`, `recoveryAction`, and binding result; package identity/digest and control are required when known. Error categories are `MANIFEST`, `COMPATIBILITY`, `INTEGRITY`, `PATH`, `DEPENDENCY`, `CAPABILITY`, `PREPARE`, `ACTIVATE`, `HEALTH`, `TIMEOUT`, `RUNTIME`, `DISPOSE`, `PERSISTENCE`, and `RECOVERY`.

### `DisposeReport`

Owned by manager. Required fields are `generation`, `slot`, `attempted`, `released`, `remaining`, `errors`, `timedOut`, and `completedAt`. Disposal is idempotent and reverse-ordered. Any remaining effect is a failure; the package x slot is quarantined and the isolated context is rebuilt before reuse.

## Repository source-of-truth map

| Subject | Source of truth | Mirrors/consumers |
| --- | --- | --- |
| Package/schema/lifecycle/fault semantics | manager ADR 0001-0003 and this table | default-skins conformance, EAC integration tests |
| Host slots/capabilities/mount/fallback | EAC ADR 0010 and HostProfile artifact | manager compatibility tests, default-skins manifests |
| Official default component/style source | default-skins repository | immutable release artifact in EAC bundle; never editable manager/EAC source after cutover |
| User selection, binding, rollback, logs | manager persisted state | EAC displays snapshot/fault/actions only |
| Tauri/WebView/resource security | EAC | manager receives narrow versioned adapters |
| Official/third-party source labels | organization catalog/build lock plus provenance | package manifest can display source but cannot self-grant official status |

## Initial dsh compatibility boundary

- `dsh-v0.1.5-rc.2` and `dsh-v0.1.6-alpha.2` are the initial required build/runtime matrix.
- Shared public typed slots may use the base adapter only when kind, scope, props, and capability probes agree.
- Changed slots such as `conversation.chat.turnTail` and `conversation.hero.agentPreset` require range-specific mappings; runtime casts are forbidden.
- Newer capabilities such as Component Factory are enabled only after capability detection.
- CSS-module hashes, source paths, private DOM/classes, and upstream HMR internals are never ABI.

## Change and release gates

1. Update the owning ADR and this table together.
2. Add or update schema and conformance fixtures before production implementation.
3. Validate both supported dsh ranges and all EAC host platforms applicable to the changed surface.
4. Record any removed old test, SKILL, or specification with its conflicting assertion, reason, and replacement gate.
5. Do not weaken traversal, asset inventory, digest, cleanup, fault isolation, fallback, or rollback tests.
6. A formal release requires real LICENSE/NOTICE/third-party inventory, reproducible artifact, provenance, checksum/digest, executable README commands, and a v6-incompatible-with-v5 changelog entry.

## Stage 0 exclusions

This document freezes contracts only. It does not claim that schemas, loader/runtime, adapters, CI, release workflows, artifacts, hot switching, or AIO migration have been implemented. Stage 1 and later must treat these versions and owners as inputs and may not reopen them without a new reviewed ADR.
