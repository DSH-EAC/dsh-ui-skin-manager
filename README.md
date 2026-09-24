# dsh-ui-skin-manager

DSH-Desktop-EAC-specific UI Skin package contracts, installer and per-slot manager.

The current contract is `dsh.eac.ui-skin/v1` / `SkinPackage`, manager API `dsh-ui-skin-manager@1`,
and EAC host profile `dsh-desktop-eac-ui-skin-profile@^0.3.0`.

## Status

This package is a usable library and CLI, not a scaffold. It has no runtime dependencies and implements:

- **Contract validation** — `SkinPackage`, host profile, slot contribution, slot binding, fault event and
  dispose report, with a SemVer range matcher that implements the npm prerelease rule, caret-zero pinning,
  compound AND sets and `||` alternation.
- **Artifact ingestion** — a hand-written ZIP codec (CRC-32 verified, data-descriptor tolerant) and the
  `dshpack-ui-skin-container@1` envelope. Absolute, traversal, percent-encoded-traversal, empty-segment,
  duplicate, symlinked, encrypted, exotic-method, ZIP64 and over-budget members are refused; so is a generic
  feature pack that is not a skin, and a directory payload entry that is a symlink, is not a regular file, or is
  missing from or extra to the declared asset inventory.
- **Content-addressed installation** — every declared SHA-256 is checked against the bytes received, the
  package digest is derived from them, and files are staged and renamed into `packages/<id>/<version>/<digest>`.
  Two payload names that are one file on a case-insensitive host are refused, a coordinate that would escape the
  store is refused before it is joined, and a digest-named directory that no longer matches its own digest is
  reported instead of trusted. A failed gate publishes nothing.
- **A persisted install index**, dependency resolution against the active host profile, and garbage collection
  that spares anything a committed, pending, draft or retained generation still references.
- **Per-slot lifecycle** — ADR 0002 sequences `discover → inspect → resolve → verify → prepare → preload →
  activate → health → commit`. `select()` verifies a choice against the catalog and the host profile and records
  it as a draft; resolving a dependency graph happens when a package is imported, not when a slot is chosen.
  `apply()` re-checks the slot against the profile, the catalog record, the quarantine list and
  that the contribution really targets the slot, then runs `prepare`, `preload`, `activate` and `health` for
  every mounted participant before anything is committed. Each stage carries the ADR deadline, and a stage that
  misses it aborts that transaction with the matching `TIMEOUT_*` code. A slot that fails keeps the binding it had.
- **Bounded cleanup** — post-commit disposal runs once per participant under the same deadline; residue there is
  collected, quarantined and reported without un-publishing the generation that already persisted.
- **Atomic persistence** — an interrupted write cannot expose a half generation, and the two most recent
  committed generations are retained for recovery. A store that fails to parse is preserved for inspection and
  reported as `PERSISTENCE_CORRUPT` rather than overwritten.
- **Force-enable** — the target is staged, a 30-second confirmation window opens, and the original binding is
  restored if the window lapses, activation fails, or the commit fails. The host supplies the stage hooks, so
  which package may be force-enabled (never `system.default`, per ADR 0002) is the host's decision, not one this
  repository can audit from a string.
- **Diagnostics** — a bounded fault store and an ADR 0002 section 6 JSONL log (16 MiB rotation, 30-day retention
  pruned at start) that redacts credentials and filesystem roots *before* persistence while keeping
  package-relative paths readable. An archive that retention cannot delete is reported as a
  `PERSISTENCE_LOG_RETENTION` warning at start, a rotation whose rename fails is reported in the write result, and
  a log directory that cannot be written at all comes back as a rejected write rather than an unhandled rejection.
- **A conformance CLI** and six published JSON Schemas (2020-12). A differential gate runs documents through both
  the schema and the TypeScript validator and fails if they diverge from the recorded expectation; the eight
  places where they differ on purpose are each justified in the gate itself.

What is deliberately **not** here: release automation for provenance and whole-archive digests, the
`system.default` skin content (it belongs to `dsh-desktop-eac-default-skins`), and the EAC host's own
Tauri/WebView runtime adapters, window behaviour and slot topology.

### Known gaps

Four ADR 0002 behaviours are implemented as state transitions but not yet as runtime behaviour. They are recorded
here rather than left implicit: the first two need a decision about host behaviour, and the last two are this
repository's own deviations from the letter of the ADR.

- **`rollback()` recovers the record, not the screen.** It re-commits the previous generation and re-points the
  manager at it; it does not run a reverse transaction, so mount hooks are not called and the display keeps
  showing the rolled-back skin until the host applies the recovered bindings (section 3).
- **Force-enable trusts the host's hooks.** `ForceEnableRequest` carries strings plus `activate`/`restore`/`commit`
  closures, so the manager cannot tell a `system.default` target from any other and cannot itself refuse to
  force the default (section 3, "non-forceable").
- **Retained generations are the last two *committed* ones.** `PreviousKnownGood` in the ADR also has to be
  complete, healthy and digest-verified; recovery validates the retained records against the binding schema and
  trusts the store's bytes from there (sections 1 and 3).
- **Deadlines are per stage.** The coordinator gives each stage the 10-second `activate` deadline, where section
  4 budgets 10 seconds for `prepare` + `preload` together and for `deactivate` + `dispose` together, so a
  transaction may spend up to 20 seconds in those pairs.

## Requirements

Node `>=22.6` (`package.json` `engines`) — `npm test` runs TypeScript directly through
`node --experimental-strip-types`; `npm run conformance` runs the compiled CLI out of `dist/`, so it needs
`npm run build` first. `npm ci` installs only `typescript` and `@types/node`.

## Try it

```bash
npm ci
npm run build
node examples/switch-slot.mjs
```

The example installs a real artifact, binds one slot, applies it through the lifecycle stages, and reads the
recovered binding back from a second manager instance. It asserts at each step, so it is a gate as well as a
demonstration. Its expected output:

```text
installed example.midnight@1.0.0 as sha256:24cfe25f926… (2 files verified)
applied ["session -> example.midnight@1.0.0"]
recovered generation 1 {"id":"example.midnight","version":"1.0.0","digest":"sha256:24cfe25f9263f10425a6f9d1f008782ea3b752f52966d2308e949b5ffb495792"}
ok
```

From an application, consume the package the same way (see `examples/switch-slot.mjs` for the complete, executed version):

```js
import {SkinManager} from "@dsh-eac/ui-skin-manager";

const manager = await SkinManager.open({
  stateDirectory: "/var/lib/eac/ui-skin",
  installRoot: "/var/lib/eac/ui-skin/packages",
  profile: await hostProfile(),            // dsh-desktop-eac-ui-skin-profile@^0.3.0
  managerVersion: "1.0.0",
  defaultPackage: {artifactPath, digest}   // digest-locked; optional
});

await manager.importPackage(artifactPath);
await manager.select([{slot: "session", packageId: "example.midnight", version: "1.0.0", contribution: "session.main"}]);
const outcome = await manager.apply((binding) => [{
  id: `dom-root@1:${binding.slot}`,        // one context per mounted participant
  prepare, preload, activate, health, commit, rollback, disposeOld
}]);
```

`select()` records a choice and changes nothing on screen; only `apply()` runs a transaction. A slot that fails
keeps the binding it had — the `binding` in its `outcome.slots` entry is the rejected candidate, and the slot
still resolves to whatever was active before — and it is reported there with its `FaultEvent`. It never cancels a
slot that already committed. `disable()`, `enable()`, `beginForceEnable()` and `collectGarbage()` are on the same object;
`manager.log` and `manager.diagnostics` are what the host renders.

`rollback()` recovers *recorded* state only — see [Known gaps](#known-gaps) for why a host has to `apply()` again
to make the display follow it.

## Checks

```bash
npm test              # the whole suite, offline, no services
npm run typecheck     # strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess
npm run format:check  # line endings, trailing whitespace, final newline
npm run build         # dist/ with .d.ts and source maps
npm run verify        # typecheck + test + format:check + build + example + conformance
```

Conformance for one or more manifests, optionally against an active host profile:

```bash
node bin/dsh-skin.mjs check test/fixtures/valid/minimal-skin.json
node bin/dsh-skin.mjs check my-skin.json --profile test/fixtures/valid/host-profile.json
```

The `test/fixtures/...` paths above are from a repository checkout: the published tarball ships `bin`, `dist`,
`examples`, `schemas` and `src`, not `test`. Substitute your own manifest and profile, or run the shipped
example with `npm run example`.

Each target prints one JSON object on stdout so release CI can consume it. Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | every target validated |
| `1` | a manifest failed validation, a target could not be read or parsed, or `--profile` named a file that fails the host-profile contract |
| `2` | the invocation was wrong: no or unknown command, unknown option, no target, `--profile` without a path, or a `--profile` file that could not be read or parsed |

## Layout

| Path | What lives there |
| --- | --- |
| `src/contracts` | models, constants, validation, the SemVer implementation |
| `src/artifact` | ZIP codec, `.dshpack` container, inventory gate, artifact loader |
| `src/installer` `src/catalog` `src/resolver` | content-addressed install, persisted index, resolution |
| `src/bindings` `src/persistence` `src/transactions` | generations, atomic JSON store, slot transactions, force-enable |
| `src/lifecycle` `src/runtime` | stage sequencing, effect ledger, fault isolation, adapter contracts |
| `src/diagnostics` `src/manager` | fault store, redaction, JSONL log, the `SkinManager` facade |
| `schemas/` | the six published JSON Schemas (2020-12) |
| `test/schema-drift.test.ts` | the gate that keeps `schemas/` and `src/contracts` in agreement |
| `docs/` | ADRs, the error-code catalogue, the cross-repo interface version table |

## Boundary

This repository owns package/schema validation, discovery, the install index, per-slot selection and binding,
lifecycle, fault isolation, effect-ledger cleanup, atomic persistence, diagnostics structure and rollback. It is
not a general application plugin manager and does not own Tauri privileges, EAC window/process/session
behaviour, or host slot topology.

There is no monolithic shell skin. Every replaceable visual element is represented by a host-owned slot; one
Skin artifact may contribute arbitrary component logic and local styles to any set of slots, and each
contribution is enabled, switched, failed, and disposed independently.

`DSH-EAC/dsh-desktop-eac-default-skins` is the only canonical source for official `system.default` content.
This repository consumes a versioned, digest-locked release artifact and does not bundle editable default or
AIO source. Third-party package artifacts are not copied into this repository.

Normative decisions: [`docs/adr/0001`](docs/adr/0001-skin-package-format.md) ·
[`docs/adr/0002`](docs/adr/0002-slot-lifecycle-fault-isolation.md) ·
[`docs/adr/0003`](docs/adr/0003-host-capability-boundary.md) ·
[`docs/ui-skin-cross-repo-interface-versions.md`](docs/ui-skin-cross-repo-interface-versions.md) ·
[`docs/error-codes.md`](docs/error-codes.md)

## Superseded placeholder decisions

The original placeholder README intentionally blocked implementation on four open questions. ADR 0001 closes
them as follows.

1. Skin packages use an independent EAC-private envelope. The official EAC `.dshpack` structure is accepted
   only as a compatibility container when it declares exactly one `SkinPackage` payload; generic Feature Pack
   contents are not skin packages, and the manager still owns inner validation and lifecycle.
2. Package coordinates are `dsh.eac.ui-skin/v1` / `SkinPackage` plus immutable ID, SemVer, and SHA-256 digest.
3. EAC slots map to public dsh APIs through explicit versioned adapters; CSS-module hashes, private
   DOM/classes, source paths, and HMR internals are not ABI.
4. Official default source is released from the separate default-skins repository; manager releases consume
   artifacts and never become a second source.

The former statement that the manager would bundle all EAC/AIO skins as built-in examples is superseded
because it conflicts with canonical-source ownership and the explicit exclusion of AIO from this migration. No
test or SKILL existed in this repository at stage 0. Future deletion of a conflicting test, SKILL, or
specification must record the obsolete assertion, the reason, the owning ADR and the replacement gate in the
same reviewed change; safety and regression gates may not be weakened merely to make CI pass. Changes made
under that rule are recorded in `CHANGELOG.md`.

## Related repositories

- `DSH-EAC/DSH-Desktop-EAC`: host profile, stable slot mounts, Tauri/WebView/resource capabilities, build
  locks, and embedded recovery fallback.
- `DSH-EAC/dsh-desktop-eac-default-skins`: official default content and reproducible release artifact.

## License

MIT — see [LICENSE](LICENSE). No `NOTICE` file exists because no notice obligation has been found; ADR 0001
forbids creating a placeholder one.
