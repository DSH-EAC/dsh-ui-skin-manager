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
  duplicate, case-colliding, symlinked, encrypted, exotic-method, ZIP64 and over-budget members are refused;
  so is a generic feature pack that is not a skin.
- **Content-addressed installation** — every declared SHA-256 is checked against the bytes received, the
  package digest is derived from them, and files are staged and renamed into `packages/<id>/<version>/<digest>`.
  A failed gate publishes nothing.
- **A persisted install index**, dependency resolution against the active host profile, and garbage collection
  that spares anything a committed, pending, draft or previous-known-good generation still references.
- **Per-slot lifecycle** — `discover → inspect → resolve → verify → prepare → preload → activate → health → commit`,
  with bounded idempotent disposal, a 30-second force-enable confirmation window that restores on failure,
  atomic persistence with two previous-known-good generations, and corruption that is preserved for inspection
  rather than laundered.
- **Diagnostics** — a bounded fault store and an ADR 0002 section 6 JSONL log (16 MiB rotation, 30-day retention)
  that redacts credentials and filesystem roots *before* persistence, while keeping package-relative paths readable.
- **A conformance CLI** and six published JSON Schemas that a drift gate proves accept exactly what the
  TypeScript validators accept.

What is deliberately **not** here: release automation for provenance and whole-archive digests, the
`system.default` skin content (it belongs to `dsh-desktop-eac-default-skins`), and the EAC host's own
Tauri/WebView runtime adapters, window behaviour and slot topology.

## Requirements

Node `>=22.6` (`package.json` `engines`) — the test and conformance scripts run TypeScript directly through
`node --experimental-strip-types`. `npm ci` installs only `typescript` and `@types/node`.

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

From an application, consume the package the same way:

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
const outcome = await manager.apply((binding) => [{id: `dom-root@1:${binding.slot}`, activate, health, commit, disposeOld}]);
```

`select()` records a choice and changes nothing on screen; only `apply()` runs a transaction. A slot that fails
keeps the binding it had and is reported in `outcome.slots` with its `FaultEvent` — it never cancels a slot that
already committed. `rollback()`, `disable()`, `enable()`, `beginForceEnable()` and `collectGarbage()` are on the
same object; `manager.log` and `manager.diagnostics` are what the host renders.

## Checks

```bash
npm test              # 172 tests, no network, no fixtures outside test/fixtures
npm run typecheck     # strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess
npm run format:check  # line endings, trailing whitespace, final newline
npm run build         # dist/ with .d.ts and source maps
npm run verify        # typecheck + test + format:check + build + conformance
```

Conformance for one or more manifests, optionally against an active host profile:

```bash
node bin/dsh-skin.mjs check test/fixtures/valid/minimal-skin.json
node bin/dsh-skin.mjs check my-skin.json --profile test/fixtures/valid/host-profile.json
```

Each target prints one JSON object on stdout so release CI can consume it. Exit codes: `0` valid, `1` a
manifest failed validation, `2` the command was wrong.

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
