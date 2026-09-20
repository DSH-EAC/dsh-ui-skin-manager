# ADR 0001: Skin package format and trust boundary

Date: 2026-09-20
Status: Accepted for v6 stage 0
Owner: dsh-ui-skin-manager maintainers (format, validation, and artifact provenance)

## Context

`dsh-ui-skin-manager` is an EAC-specific UI skin package loader and manager. It is not a general application plugin manager and it does not define a public ecosystem-wide authoring convention. The EAC host already has a built-in `ui-skin` package baseline in `DSH-Desktop-EAC` ADR 0009, while this repository currently contains only a placeholder README. The old README's open questions are therefore closed by this ADR.

The package format must support arbitrary third-party component, logic, and local style contributions without treating an untrusted package as trusted code. The manager must own discovery, validation, installation, selection, binding, lifecycle, cleanup, and rollback. The host owns the capability boundary. `dsh-desktop-eac-default-skins` is the only canonical source for the official default skin source; this repository consumes a versioned release artifact and never becomes its source mirror.

## Decision

### 1. Package identity and envelope

A distributable artifact is a manager-private package with a stable coordinate and an auditable envelope. The payload is not a `.dshpack` feature-pack payload and does not share the feature-pack registry or lifecycle implicitly.

Required package coordinate:

| Field | Frozen rule | Owner |
| --- | --- | --- |
| `apiVersion` | `dsh.eac.ui-skin/v1` | manager format owner |
| `kind` | `SkinPackage` | manager format owner |
| `metadata.id` | Lowercase reverse-DNS identifier, `[a-z0-9]+(?:[.-][a-z0-9]+)*`; immutable for a package lineage | package publisher; validated by manager |
| `metadata.version` | SemVer 2.0.0; immutable for a published artifact | package publisher; validated by manager |
| `metadata.name` | Human-readable display name; not an identity | package publisher |
| `metadata.author` | Attribution string; not an authority claim | package publisher |
| `engines.manager` | SemVer range for the manager contract | manager format owner |
| `engines.hostProfile` | Exact profile/range required by contributions | host-profile owner; validated by manager |
| `engines.dsh` | Optional explicit dsh version range for typed-slot contributions | dsh adapter owner; validated by manager |
| `contributions` | Non-empty array; each item targets exactly one slot | package publisher; validated by manager |
| `assets` | Complete relative asset inventory with a SHA-256 digest for every payload file | package publisher; validated by manager |
| `integrity` | Required per-file `sha256` map; optional signature/provenance references | package publisher; verified by manager |

The manager does not accept a manifest's self-declared official tag as proof of origin. The official tag is assigned by the organization catalog and is displayed separately from package identity. A package without a signature is not rejected solely for that reason; digest, path, schema, compatibility, and capability checks remain mandatory.

The canonical artifact layout is a deterministic archive containing `manifest.json`, contribution entrypoints, declared assets, `LICENSE` where applicable, `NOTICE` only when an actual obligation exists, and `THIRD-PARTY-NOTICES.md`. `manifest.json` records the digest of every other archived payload file; it cannot contain the digest of the archive that contains it. The release workflow computes the whole-archive SHA-256 after assembly and records it in the external organization catalog, EAC build lock, release checksum file, and provenance sidecar. Archive extraction must reject absolute paths, traversal, symlink escape, undeclared files, duplicate normalized paths, and per-file or whole-archive digest mismatch.

### 2. Skin and contribution model

The package is not a monolithic shell skin. A package may provide any combination of component, logic, and local style, but every replaceable visual surface must be represented by a host `Region`/`Slot` contribution. A contribution has the following frozen fields:

| Field | Frozen rule | Owner |
| --- | --- | --- |
| `contribution.id` | Unique within package; stable across compatible releases | package publisher |
| `slot` | Exact host slot identifier; no fuzzy name matching | host profile owner |
| `entry` | Relative module entry under the extracted package root | package publisher; manager path validator |
| `assets` | Relative paths, each present in the package inventory | package publisher; manager validator |
| `style` | Optional declared style entry/assets, scoped to the contribution | package publisher |
| `requires.capabilities` | Explicit host capability identifiers and versions | host capability owner |
| `requires.slotKind` | Exact supported slot kind set | host profile owner |
| `requires.slotScope` | Exact supported slot scope set | host profile owner |
| `lifecycle.mount` | Contribution activation hook | package publisher; isolated by manager |
| `lifecycle.health` | Health/readiness hook with bounded timeout | package publisher; isolated by manager |
| `lifecycle.unmount` | Cleanup hook; manager verifies its effect ledger | package publisher; isolated by manager |

A contribution cannot claim a slot owned by another package in the same committed binding. Duplicate `(slot, contribution.id)` entries, duplicate normalized assets, undeclared asset references, and contributions targeting unknown slots are validation errors before activation.

### 3. Host profile and context boundary

`HostProfile` is host-owned and versioned independently from the package. Its minimum fields are `id`, `version`, `regions`, `slots`, `instanceKinds`, `mountContract`, `zIndexPolicy`, `capabilities`, and `fallbackSkin`. The initial profile is `dsh-desktop-eac-ui-skin-profile@^0.3`, with regions `top-sidebar`, `bottom-sidebar`, `left-sidebar`, `right-sidebar`, `session`, and `overlay`; `popup`, `dialog`, and `floating-window` are instance kinds, not binding-table regions.

`SkinContext` contains slot props, a restricted capability object, a structured logger, and an `AbortSignal`. It never exposes Tauri internals, private DOM objects, filesystem paths, process handles, or an unversioned host object. A manager adapter may expose public dsh `ctx.theme`, `ctx.slots`, and Cordis disposal semantics only through a versioned adapter; CSS-module hashes and upstream private DOM/classes are not ABI.

### 4. Trust, provenance, and licensing

Trust is layered, not binary:

1. The package's origin and displayed source are metadata, not permission to bypass validation.
2. SHA-256 integrity is mandatory: the manifest covers payload files, while the external catalog/build lock covers the complete artifact bytes.
3. Optional signatures and organization catalog tags add provenance but do not replace schema, compatibility, path, or capability checks.
4. Third-party content is explicitly marked as third-party and not covered by official functional or security guarantees.
5. Every distributed artifact carries its actual license and attribution obligations. The default-skins repository uses MIT with `Copyright (c) 2026 zouyuxuan122`; an empty `NOTICE` is not created. If later inventory discovers a real notice obligation, release CI must generate and validate it before release.

`THIRD-PARTY-NOTICES.md` is required when an artifact carries third-party material; its entries include name, version, source URL, license, copyright, modification status, and accompanying-text path. Provenance is generated by release automation and includes source commit, workflow/run, builder, build time, lock/digest inputs, manager/profile versions, artifact filename, and digest. It must not contain tokens, private local paths, or user data.

### 5. Versioning and compatibility

The following axes never substitute for one another: manager API/schema, host profile/capability, package SemVer, `engines.manager`, `engines.hostProfile`, `engines.dsh`, and artifact digest/signature policy. Unknown higher manifest versions, unsupported manager/profile ranges, incompatible dsh ranges, missing required capabilities, and malformed SemVer fail before activation.

The v6 initial default identity remains `system.default@2.0.0` under profile `dsh-desktop-eac-ui-skin-profile@^0.3`. A breaking contract change increments the relevant major version and requires an explicit compatibility-table update. There is no permanent `/skin/tokens.css` alias and no AIO migration in this stage.

### 6. Rejected alternatives

- `.dshpack` payload: rejected for v6 because the skin manager needs a private package contract and slot-scoped lifecycle; reusing a general feature-pack envelope would blur ownership and capability boundaries.
- Monolithic `shell-skin`: rejected because it prevents independent slot composition and conflicts with EAC ADR 0009.
- Manifest-declared official/trusted flag: rejected because a package cannot grant itself authority.
- Signature-only trust: rejected because signatures do not validate paths, assets, compatibility, or runtime isolation.
- Copying default source into manager: rejected because it creates two canonical sources and allows drift.
- Rejecting every unsigned third-party package: rejected by the confirmed product decision; unsigned packages remain visibly third-party and must pass all non-signature gates.

## Conflict cleanup and replacement gates

The placeholder README's open decisions are superseded by this ADR and the interface version table. Its statements that all EAC/AIO skins should be bundled with the manager are invalid for v6: official default source belongs only to `dsh-desktop-eac-default-skins`, and manager releases consume locked artifacts. No old test, SKILL, or specification may be deleted merely to make CI pass. Any future removal must record the exact path, obsolete behavior, replacement ADR/test, and replacement release gate. The replacement gate for this ADR is schema, path-safety, digest, license/provenance, and compatibility conformance testing before `activate`.

## Consequences

The manager can validate and audit a package before any slot is changed, while arbitrary package internals remain the publisher's responsibility. The host profile remains the single owner of slot topology and capabilities. The format is intentionally private to EAC and can evolve through the version table without pretending to be a universal plugin protocol.

## Acceptance evidence

- The package coordinate, contribution fields, host boundary, trust rules, licensing rules, and rejected alternatives are fixed here.
- The initial profile, default identity, regions, instance kinds, and dsh compatibility axes match EAC ADR 0009 and the stage 0 plan.
- The implementation gate is conformance testing; this ADR does not claim a loader or runtime implementation exists.
