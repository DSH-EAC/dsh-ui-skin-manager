# Changelog

All notable changes to this repository are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses SemVer.

Contract identity is frozen independently of the package version: `dsh.eac.ui-skin/v1` / `SkinPackage`,
manager API `dsh-ui-skin-manager@1`, host profile `dsh-desktop-eac-ui-skin-profile@^0.3.0`. See
`docs/ui-skin-cross-repo-interface-versions.md` for the cross-repo compatibility matrix.

## [0.1.0-preview.1]

Not released yet. No published version precedes this one, so nothing below is a break for an existing
consumer; it is the difference between the placeholder repository and a usable package.

### Added

- `src/contracts/semver.ts`: a real range matcher — caret-zero pinning, tilde patch-only, compound AND
  clauses, `||` alternation, the npm prerelease rule, and build metadata ignored for precedence.
- `src/artifact/`: a dependency-free ZIP codec (central-directory driven, CRC-32 verified, data-descriptor
  tolerant, byte-deterministic writer), the `dshpack-ui-skin-container@1` reader, the inventory gate that
  checks every declared SHA-256 against received bytes, and one loader for a directory, an archive or a pack.
- `src/installer/package-installer.ts`: content-addressed installation with staging, atomic publish, a
  digest lock the caller can pin, and a refusal of names that NTFS would fold into one file.
- `src/catalog/package-catalog.ts`: a persisted install index, so installed packages and the bindings that
  resolve them survive a restart.
- `src/resolver/package-resolver.ts`: dependency resolution against the active host profile, with the
  fallback derived from `profile.fallbackSkin` instead of a hard-coded coordinate.
- `src/diagnostics/redaction.ts` and a bounded fault store that never launders an invalid entry.
- `src/diagnostics/structured-log.ts`: the ADR 0002 section 6 JSONL export — 16 MiB rotation, 30-day
  retention, redaction applied before persistence.
- `src/manager/skin-manager.ts`: one facade over recovery, import, selection, apply, rollback, disable,
  force-enable and garbage collection.
- `src/cli.ts` and `bin/dsh-skin.mjs`: `check`, `version`, `help`, one JSON object per target, exit codes
  `0`/`1`/`2`. Replaces `bin/conformance-preview.mjs`.
- A compiled `dist/` with declarations and source maps, a package `exports` map including
  `./schemas/*`, and a CI job that packs the tarball, installs it into a scratch project and uses it from
  plain Node.
- `test/schema-drift.test.ts` with a keyword-subset gate: each published JSON Schema must accept exactly the
  documents its TypeScript validator accepts, and any asymmetry has to carry a reason.
- `examples/switch-slot.mjs`, `LICENSE` (MIT, `Copyright (c) 2026 zouyuxuan122`), this file, and `.gitattributes`
  pinning LF (the organization default of `core.autocrlf=true` was producing mixed line endings in checked-out
  sources). No `NOTICE` is created: ADR 0001 forbids a placeholder for an obligation that does not exist.

### Fixed

- `satisfiesVersion` accepted a version outside the range for several grammars, so an incompatible skin could
  install; a manifest with an unknown `engines` axis was accepted silently.
- A force-enable window that was never confirmed could strand a slot in the forced target, and a failing
  commit restore left it there; `keep()` now restores and settles, and a restore failure is reported.
- The slot transaction coordinator ran post-commit cleanup inside the rollback guard, so a disposal error
  could roll back a generation that had already been persisted.
- `AtomicJsonStore` reported a first run (ENOENT) as corruption and created a bogus backup of nothing.
- `redact()` wrote a literal `$1` into messages and removed `2026-09-24` and package-relative paths while
  leaving `Authorization: Bearer <token>` intact.
- Effect-ledger disposal was unbounded: a package whose disposer hung blocked the slot forever. Disposal is
  now bounded and reports `timedOut` with the effects that remain.
- The resolver could commit two providers of the same id and pick one silently; a second, incompatible
  constraint is now `DEPENDENCY_CONFLICT`.
- Two rotations inside one millisecond renamed onto the same archive and discarded the older log.
- `PackageCatalog.install` took a reference on every import that nothing ever released, which made garbage
  collection unreachable for anything the manager installed.
- `SkinManager.open()` re-bound every contributed slot to the default skin on each start, overwriting the
  user's saved choice; the default now seeds only slots that carry no binding.
- A package quarantined for a slot could be switched straight back in, so `disable()` recorded a fault and
  changed nothing. Selection and apply now refuse a quarantined coordinate until `enable()`. The default
  reason became `CAPABILITY_USER_DISABLED` (the previous `USER_DISABLED` is not a valid code in any
  category), and a reason that is not a stable error code is refused at the call instead of being written
  out and making the whole quarantine file unreadable on the next start.
- Eight pre-existing type errors (implicit `any` inside a frozen runtime context, a disposer whose return type
  did not match, `exactOptionalPropertyTypes` mismatches) are gone and `npm run typecheck` gates CI.

### Changed

Repo policy requires a recorded obsolete assertion, reason, owning ADR and replacement gate for any changed
test meaning. These are those changes.

- `validateBindingGeneration` required every binding's `generation` to equal the record's. Per-slot
  activation (ADR 0002 section 3) commits one slot at a time, so that rule rejected coherent state as
  corrupt. The assertion in `test/manager-core.test.ts` was replaced by a future-generation check; the
  replacement gate is the committed-state assertions in `test/manager.test.ts`.
- `PackageCatalog.install` no longer increments `refCount`. Durable state is what holds a package
  (ADR 0002 section 1), and the old rule made the retention policy unenforceable. The "install returns 1,
  then 2" assertions were replaced with idempotent-registration and explicit-hold assertions; the
  replacement gates are `collection spares anything a generation references…` in `test/catalog.test.ts` and
  `collectGarbage spares anything a binding or the host profile still references` in `test/manager.test.ts`.
- `test/zip.test.ts` moved `a//b.css` from its allowed-name list to its refused list, so the archive gate
  matches `isSafePath` instead of disagreeing with the installer about empty segments.
- The host-profile and contribution validators were tightened to match what the published schemas already
  promised: a capability must carry `id` and `version`, `zIndexPolicy` bounds must be integers, region and
  slot strings must be non-empty, `slotKind` and `slotScope` must be non-empty lists, a fault `detail` must be
  a map, and a version no longer accepts a `v` prefix.
- `schemas/slot-contribution.schema.json` now uses the shared `safePath` definition for `entry`, `assets` and
  `style`, and `schemas/host-profile.schema.json` no longer pins `instanceKinds` to three values. The
  `semverRange` and `errorCode` patterns were rewritten to the grammars in `src/contracts`.
