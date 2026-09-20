# ADR 0003: Host capability and slot boundary

Date: 2026-09-20
Status: Accepted for v6 stage 0
Owner: DSH-Desktop-EAC maintainers (host profile and capabilities); dsh-ui-skin-manager maintainers (capability mediation and enforcement)

## Context

Skin contributions may contain arbitrary UI logic, but they run inside a desktop application with Tauri, WebView, filesystem, process, session, RPC, window, tray, and boot privileges. Passing private host objects into `SkinContext` would turn a UI skin package into an unversioned application plugin and make cleanup, compatibility, and trust impossible to audit.

The host must retain a minimal recovery surface that does not depend on the manager or default package. At the same time, useful UI contributions need a small versioned set of operations such as window controls, close-dialog behavior, logging, and diagnostics.

## Decision

### 1. Independent versioned host profile

The host publishes a `HostProfile` independently from package schema and application version. The initial compatible profile remains `dsh-desktop-eac-ui-skin-profile@^0.3`. A profile descriptor contains:

| Field | Rule | Owner |
| --- | --- | --- |
| `id` | `dsh-desktop-eac-ui-skin-profile` | EAC host |
| `version` | SemVer; incremented for slot/capability contract changes | EAC host |
| `regions` | Host visual region descriptors | EAC host |
| `slots` | Exact slot IDs, kind, scope, props schema, mount contract, fallback | EAC host |
| `instanceKinds` | `popup`, `dialog`, `floating-window` initially | EAC host |
| `zIndexPolicy` | Per-slot layers/ranges; contribution cannot escape its allocation | EAC host |
| `capabilities` | Versioned capability descriptors | EAC host |
| `dshAdapters` | Explicit EAC slot to public dsh slot mappings by supported dsh range | EAC host adapter owner |
| `fallbackSkin` | `system.default` coordinate and required digest supplied by build lock | EAC build owner |

The initial host regions are `top-sidebar`, `bottom-sidebar`, `left-sidebar`, `right-sidebar`, `session`, and `overlay`. They are a starting set, not permission to leave other replaceable visual elements outside the slot system. Every replaceable visual element must either belong to an existing slot or receive a new versioned host slot. There is no shell-skin package or bypass appearance layer.

`popup`, `dialog`, and `floating-window` are instance kinds. Their factories/content are contributed through a slot contract; instances do not become singleton region bindings.

### 2. Capability identifiers and least authority

Capabilities use reverse-DNS identifiers and independent SemVer versions. A package declares required capability ranges per contribution; the manager rejects missing/incompatible requirements before activation. v1 permits only the following capability families:

| Capability | Allowed operation | Host owner |
| --- | --- | --- |
| `io.github.dsh-eac.window.controls@1` | Request drag, minimize, maximize/restore, and close for the contribution's current window | Tauri window adapter |
| `io.github.dsh-eac.dialog.close@1` | Request closure of the current host-owned dialog instance | host dialog adapter |
| `io.github.dsh-eac.diagnostics@1` | Open logs, copy redacted diagnostics, request retry/disable/restore-default actions | host diagnostics adapter |
| `io.github.dsh-eac.ui.notifications@1` | Emit bounded host notifications with host-controlled rendering | host UI adapter |
| `io.github.dsh-eac.dsh.theme@1` | Access the public `ctx.theme` adapter for a compatible dsh range | dsh adapter |
| `io.github.dsh-eac.dsh.slots@1` | Register through mapped public `ctx.slots` keys and receive Cordis-compatible disposal | dsh adapter |

The capability object is frozen, scoped to one contribution and generation, revocable on abort/dispose, and unavailable unless declared. Capability calls include the slot/generation/correlation context. They never expose raw Tauri handles, invoke arbitrary commands, spawn processes, read arbitrary files, access unrestricted network/RPC, inspect secrets, control other windows, or mutate another slot.

New capability families require a host ADR, a version-table update, threat analysis, denial-path behavior, and conformance tests before release. A package cannot obtain capability by probing private globals or host DOM.

### 3. Mount and DOM boundary

The host owns real DOM/context creation and stable `data-region`, `data-control-name`, and `data-state` anchors. The profile gives each contribution a mount root, props schema, lifecycle, z-index allocation, and capability set. The contribution owns content inside its mount root. It may not use CSS-module hashes, upstream private classes, source paths, or bundle patches as ABI.

The manager adapter enforces contribution-local styles and records inserted style/link/theme layers in the effect ledger. A contribution must not style or remove host recovery UI, window controls outside its slot, another slot's root, or the embedded fallback. Where browser-level isolation cannot prevent selector escape, the adapter must scope/rewrite/reject the style before activation or isolate the contribution in a stronger context; this is a required health gate.

The host may map EAC slots to public dsh `ctx.slots`, `ctx.theme`, and Cordis disposer semantics. Mapping is explicit and versioned by `engines.dsh`; similar names are not compatibility. A changed dsh slot `kind`, `scope`, or props requires a separate adapter build/range. Runtime casts do not create compatibility.

### 4. Host-owned fallback and resource channel

The host retains:

- boot/loading/died/recovery pages and essential window controls;
- the minimal embedded fallback needed to start, inspect diagnostics, and repair manager/default state;
- the safe `/skin/` or equivalent resource channel with canonical path resolution, inventory whitelist, MIME policy, and traversal/symlink escape rejection;
- exact build locks for manager and default artifact version/digest;
- platform log open/copy integration and crash-start recovery entrypoints.

The embedded fallback is not a customizable Skin and is not offered in the normal slot selector. It contains no product skin source beyond the minimum recovery surface. The host does not reimplement package discovery, dependency resolution, slot selection, lifecycle ordering, effect tracking, or rollback policy.

### 5. Manager-owned mediation

The manager consumes `HostProfile` and exposes only resolved capabilities in `SkinContext`. It owns requirement matching, per-generation revocation, timeout/abort propagation, structured capability faults, effect-ledger registration, and adapter disposal. A denied call yields a stable `CAPABILITY_*` fault in the calling slot; it does not crash the host or silently grant broader access.

The host consumes only an already verified `ActiveBindingSnapshot`, resolved asset set, generation, and fault state. The snapshot contains no executable host authority. It is rejected if its profile version or locked digest does not match the host's build/runtime constraints.

### 6. Official source and content boundary

`dsh-desktop-eac-default-skins` owns the source for official default slot contributions. The EAC repository may contain a locked release artifact needed for offline startup and recovery, but not a second editable source tree after canonical-source migration. The manager repository contains no official default source or bundled AIO skins. AIO is outside this migration and may later ship as a separate alternative Skin package under a separate task.

Official status comes from the organization catalog/build lock, not package self-declaration. Third-party packages see the same capability API and validation path but are visibly labeled third-party and not officially guaranteed.

### 7. Rejected alternatives

- Raw Tauri/WebView/private host object in `SkinContext`: rejected as unversioned privilege escalation.
- Arbitrary command, filesystem, process, network, or RPC capability: rejected; future narrow use cases require separate ADRs.
- CSS-module hash or private DOM selector as ABI: rejected because upstream builds may change them without notice.
- Name-based EAC-to-dsh slot matching: rejected because dsh `kind`, `scope`, and props change across versions.
- Customizable embedded fallback: rejected because recovery must not depend on the subsystem being repaired.
- Host-owned lifecycle policy: rejected because it would duplicate manager responsibility and create divergent rollback behavior.

## Conflict cleanup and replacement gates

EAC ADR 0009 remains the migration baseline for static package identities and stable anchors. Its statement that future registry bindings may replace Control and Style is refined here: v6 runtime binding is contribution-per-slot and owned by the manager, while host topology remains host-owned. EAC ADR 0005/0007 and old `assets/shell-skin` behavior remain historical only and must not be copied into this implementation. Any conflicting test, SKILL, or specification removal must record the obsolete assertion and replace it with profile schema, capability denial/revocation, traversal/whitelist, DOM/style isolation, fallback independence, and dsh adapter compatibility tests.

## Consequences

Skin contributions receive useful UI operations without becoming general EAC plugins. Host recovery remains operable even when manager/default artifacts are corrupt. Adding capability requires explicit ownership and versioning, making the security and cleanup boundary testable.

## Acceptance evidence

All host-profile, slot, mount, capability, adapter, fallback, official-source, and denial responsibilities have an owner and a fixed v1 rule. No loader or runtime implementation is included in this ADR.
