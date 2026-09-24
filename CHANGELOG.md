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
- `test/schema-drift.test.ts` with a keyword-subset gate: every published JSON Schema is run against its
  TypeScript validator over an enumerated case table, and any case where the two differ has to name the
  direction and carry a reason in the gate itself.
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
- `installer.versionPath()` joined a caller-supplied `id`, `version` and `digest` straight onto the store root,
  so a package coordinate carrying `..` or a path separator could publish outside the store. The coordinate is
  now checked against the same `isPackageId` / SemVer / `sha256:<64 hex>` rules the rest of the pipeline uses
  before any path is built.
- Staging used a predictable `${target}.staging-<pid>-<timestamp>` name created with `mkdir(recursive)`, which
  would follow a directory or symlink planted at that path by anything sharing the store. It is now created
  exclusively with `mkdtemp`, and the parent chain of every written file is probed for a symlink between the
  staging root and the payload.
- A store entry that already existed was returned as `alreadyInstalled` without re-reading it, so a
  digest-named directory whose bytes had since been altered kept being installed. Both reuse paths now
  re-verify that the published bytes still hash to the digest that names them.
- A lifecycle failure reported `ACTIVATE_<stage>` whatever the stage, so the `PREPARE_*`, `HEALTH_*`,
  `DISPOSE_*`, `PERSISTENCE_*` and `TIMEOUT_*` categories the error catalogue defines were unreachable. Each
  stage now maps to its own code, a deadline miss to the matching `TIMEOUT_*`, and an unmapped stage to
  `RUNTIME_FAILURE` rather than to a misleading one.
- A fault recorded during a timed-out stage carried the stage name as its `lifecycleStage` instead of the ADR
  stage it belonged to.
- `StructuredLog.purge()` returned a count, so archives it could not delete were indistinguishable from none
  being expired; it now reports `{removed, failures}` and `SkinManager.open()` records a
  `PERSISTENCE_LOG_RETENTION` warning per failure. A rotation whose rename failed was reported as a rotation.
- An unusable log directory made the queued write reject, and because `record()` does not await it that became an
  unhandled rejection - which is Node's default way of ending the process. A write now always resolves with
  `{written: false, rejected}`; `flush()` can no longer reject for an I/O cause either.
- `open()` flushes the log before rethrowing a fatal startup failure, so the line explaining why startup died is
  not lost with the process.
- `readContainer()`'s `DSHPACK_CONTAINER_INTERFACE` export named nothing in `pack.json` and was never read; the
  constant is gone and the interface-table row is documented as naming the behaviour.
- `test/resolver.test.ts` asserted `notEqual(a, b)` on two objects, which is true for any two distinct
  references and so passed whatever the resolver did. It now compares identity and content.
- `package-lock.json` was regenerated against `registry.npmjs.org`; it had recorded a mirror host from a
  developer-local `.npmrc`, which `npm ci` on a clean machine resolves inconsistently.
- CI: the package job `mv`'d the tarball out of the directory it then uploaded, so the artifact glob matched
  nothing; it copies instead. The conformance job now runs `npm run build` explicitly rather than inheriting it
  from `npm ci`'s `prepare`, because its `example` and `conformance` steps read `dist/` directly.
- CI: the conformance step named `test/fixtures/valid/host-profile.json` as a second *target* as well as passing
  it through `--profile`. `check` validates every positional argument as a `SkinPackage`, so the step asked the
  CLI to reject the host profile and it correctly did - exit `1` with seven `MANIFEST_*` issues, on every run
  since the step was added. Only the earlier failures hid it; making `npm test` pass is what surfaced this.
- `loadArtifact()` read an archive into a `Uint8Array` before anything asked how big it was: the 512 MiB ceiling
  lives in `readZip`, which only runs once the bytes are already in memory, so a hostile `skin.zip` of any size
  ended the host process before it could be refused. The `lstat` two lines above already reported the size, and
  it is now the thing that decides whether to read. The directory branch had no ceiling at all - not per member,
  not in aggregate, not by count - and has all three. `ARCHIVE_LIMITS` is exported so the two paths cannot drift
  apart into different budgets.
- `redact()` looked for `token`, `secret` and friends behind a `\b`, which is false inside `access_token=`,
  `refresh_token=`, `id_token=` and `client_secret:` because `_` is a word character - the four spellings an
  OAuth-facing host actually logs. Those keys were written to the JSONL log verbatim. The assertion now names the
  segments a key is built from, so `aws_secret_access_key=` is covered while `tokenizer=v2` and `secretive:true`
  still survive, and the whole key stays readable (`client_secret=<redacted>`) because a line that says only
  `=<redacted>` tells an operator nothing. Separately, `redactDetail` trusted the field *name* over its content:
  `{slot: {token: "…"}}` rode out untouched under a name the reviewer assumes is a primitive. A visible name now
  licenses a primitive only, and anything structured takes the hash branch.
- A fault whose `errorCode` came from the validator or the archive reader was persisted and then dropped:
  `ASSET_UNDECLARED`, `CONTRIBUTION_DUPLICATE`, `ARCHIVE_*` and `ARTIFACT_*` are finer than the fourteen
  categories, so `validateFaultEvent` refused them, `DiagnosticStore` counted them away, and the log line became
  `RECOVERY_DIAGNOSTIC_UNCLASSIFIED` - the thrown error and the persisted fault disagreed about what had failed.
  `toFaultCode` folds each family onto its owning category at `record()` and the source code is appended to the
  message, so grepping the category finds the line. `docs/error-codes.md` now says which namespace is which.
- `install-index.json` carried `versionPath` as an arbitrary non-empty string and nothing compared it to the path
  the store would have written for that record's own `id`, `version` and `digest`. The coordinate validators added
  no coverage here: they check the path built *from* a coordinate, while the index supplies one *alongside* it, and
  that is the field the host reads to find the code it imports. `PackageCatalog.load()` now drops a record whose
  path does not equal `storePath(root, …)` and reports it.
- `apply()`, `rollback()`, `persist()`, `select()` and `disable()` each read `#bindings`, merged into it and wrote
  it back, but nothing took a turn: a rollback issued while an apply was suspended in a hook had its write
  overwritten by that apply a moment later, and both calls reported success. The comment claiming slots never race
  was only true inside one call. Every read-modify-write of the binding set now runs under one manager lock.
- `ForceEnableController.keep()` removed the pending record before awaiting `commit()`, so a commit that outlived
  the confirmation window left the expiry timer with nothing to find: the 30 seconds that exists precisely to undo
  a forced binding had been disarmed by the act of keeping it. The record stays pending until the commit settles,
  and a commit that lands after a restore reports `restored` rather than claiming a keep.
- A throw that was not a staged failure - a host whose `contexts` factory cannot build one, a `structuredClone`
  that meets something uncloneable - was reported as `ACTIVATE_MOUNT` at stage `activate`, pointing at a hook that
  never ran. It is reported under `RUNTIME_*`/`runtime` now, which is what is actually known.
- A disposal residue that could not be quarantined was raised inside the same `try` as the transaction itself, so
  a slot that had committed, persisted and mounted was reported to the host as a failed activation. Post-commit
  bookkeeping is now outside that block: the switch reports `active`, and the residue that could not be recorded
  rides along in `disposeErrors` with a `PERSISTENCE_QUARANTINE` fault.
- `open()` flushed the log on one of its three fatal paths (the digest-locked default failing). The host profile
  rejection and the default binding step both died with their faults in memory. Flushing now happens on every
  startup failure, and cannot itself become the error the caller sees: `rotate()` used to leave its rejection in
  the write queue, where the next `flush()` would surface a rename error in place of the startup error it was
  asked to report.

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
- `StructuredLog.purge()` returns `PurgeResult` (`{removed, failures}`) instead of a bare `number`, and
  `LogWriteResult` gained `rotationError`. Both types ship only in this unreleased preview, so no consumer is
  broken; the replacement gate is `a retention deletion that fails is reported instead of swallowed` in
  `test/structured-log.test.ts`.
- `test/manager.test.ts` asserted `ACTIVATE_HEALTH` and `ACTIVATE_ACTIVATE` on failed slots. Those two strings
  are in no category of `docs/error-codes.md`, so the assertion had frozen the bug rather than the contract. They
  now read `HEALTH_CHECK` and `ACTIVATE_MOUNT`, and `validateFaultEvent(fault).ok` is asserted alongside them -
  the error-code catalogue is the gate, not a literal repeated from the implementation. Owning ADR: 0002
  sections 3 and 4.
- A new `test/manager.test.ts` case drives a stage past its deadline and asserts the `TIMEOUT_*` code and the
  stage it names, so the timeout category cannot regress into the generic one again.
- A new `test/structured-log.test.ts` case asserts that an unwritable log directory resolves with
  `{written: false}` and leaves no unhandled rejection, which is the crash-prevention gate for the
  fire-and-forget path `record()` uses.
- `test/cli.test.ts` now pins the documented asymmetry: an unreadable target is exit `1`, an unreadable
  `--profile` path is exit `2`, and `src/cli.ts` prints the same rule in its own help text.
- The README's status section was rewritten to describe the sequence the code actually runs, and the four
  behaviours it does not yet run are listed under **Known gaps** instead of being implied: `rollback()` recovers
  recorded state without a reverse transaction; force-enable trusts the host's hooks, so the ADR 0002 rule that
  `system.default` is non-forceable is the caller's to enforce; retained generations are the last two committed
  ones rather than the ADR's complete/healthy/digest-verified `PreviousKnownGood`; and the coordinator applies
  the 10-second deadline per stage, where ADR 0002 section 4 budgets 10 seconds for `prepare` + `preload` and for
  `deactivate` + `dispose` combined.
- `ACTIVATE_HEALTH` was in fact a legal code (`ACTIVATE` is one of the fourteen categories), so the reason first
  recorded for replacing it was wrong even though the change itself stands: a health probe that answers "no" is a
  `HEALTH_*` failure and a probe that hangs is a `TIMEOUT_*` one, and labelling both `ACTIVATE_*` makes the
  `HEALTH_` prefix unreachable for an operator. The assertion now reads `HEALTH_CHECK` for that reason. Owning
  ADR: 0002 sections 3 and 4.
- Public surface added in this preview, all of it additive: `ARCHIVE_LIMITS` and the `ArtifactLimits` type,
  `loadArtifact(source, limits)` (the second argument defaults to `ARCHIVE_LIMITS`, so an existing call site is
  unchanged), the module-level `storePath(root, id, version, digest)` that `PackageInstaller.versionPath` now
  delegates to, `PackageCatalog({packagesRoot})`, and `toFaultCode`. `packagesRoot` is optional and a catalog
  constructed without it performs no path cross-check, which is what `test/catalog.test.ts` does.
- `SkinManager.select`, `apply`, `rollback`, `disable` and `persist` are now serialized against each other. A host
  that relied on overlapping them to interleave work will see them queue instead; nothing they could achieve by
  overlapping was coherent, since each one merged into `#bindings` from a snapshot the others could not see. The
  replacement gate is `a rollback that overlaps a suspended apply is not overwritten by its commit` in
  `test/manager.test.ts`.
