# dsh-ui-skin-manager

DSH-Desktop-EAC-specific UI Skin package loader and manager.

## Status

Stage 0 freezes the v6 contracts and ownership boundaries. No loader, runtime, schema implementation, CI artifact, or release is claimed yet.

Normative decisions:

- `docs/adr/0001-skin-package-format.md`
- `docs/adr/0002-slot-lifecycle-fault-isolation.md`
- `docs/adr/0003-host-capability-boundary.md`
- `docs/ui-skin-cross-repo-interface-versions.md`

The current contract is `dsh.eac.ui-skin/v1` / `SkinPackage`, manager API `dsh-ui-skin-manager@1`, and EAC host profile `dsh-desktop-eac-ui-skin-profile@^0.3.0`.

## Boundary

This repository owns package/schema validation, discovery, install index, per-slot selection and binding, lifecycle, fault isolation, effect-ledger cleanup, atomic persistence, diagnostics structure, and rollback. It is not a general application plugin manager and does not own Tauri privileges, EAC window/process/session behavior, or host slot topology.

There is no monolithic shell skin. Every replaceable visual element is represented by a host-owned slot; one Skin artifact may contribute arbitrary component logic and local styles to any set of slots, and each contribution is enabled, switched, failed, and disposed independently.

`DSH-EAC/dsh-desktop-eac-default-skins` is the only canonical source for official `system.default` content. This repository consumes a versioned, digest-locked release artifact and does not bundle editable default or AIO source. Third-party package artifacts are not copied into this repository.

## Superseded placeholder decisions

The original placeholder README intentionally blocked implementation on four open questions. Stage 0 closes them as follows:

1. Skin packages use an independent EAC-private envelope. The official EAC `.dshpack` structure is accepted only as a compatibility container when it declares exactly one `SkinPackage` payload; generic Feature Pack contents are not skin packages, and the manager still owns inner validation and lifecycle.
2. Package coordinates are `dsh.eac.ui-skin/v1` / `SkinPackage` plus immutable ID, SemVer, and SHA-256 digest.
3. EAC slots map to public dsh APIs through explicit versioned adapters; CSS-module hashes, private DOM/classes, source paths, and HMR internals are not ABI.
4. Official default source is released from the separate default-skins repository; manager releases consume artifacts and never become a second source.

The former statement that manager would bundle all EAC/AIO skins as built-in examples is superseded because it conflicts with canonical-source ownership and the explicit exclusion of AIO from this migration. No test or SKILL existed in this repository at stage 0. Future deletion of a conflicting test, SKILL, or specification must record the obsolete assertion, deletion reason, owning ADR, and replacement gate in the same reviewed change; safety and regression gates may not be weakened merely to make CI pass.

## Related repositories

- `DSH-EAC/DSH-Desktop-EAC`: host profile, stable slot mounts, Tauri/WebView/resource capabilities, build locks, and embedded recovery fallback.
- `DSH-EAC/dsh-desktop-eac-default-skins`: official default content and reproducible release artifact.

Implementation begins only after the stage 0 ADR set is reviewed and explicitly approved.
