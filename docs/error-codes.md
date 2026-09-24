# Stable error-code categories

Contract preview: `dsh-ui-skin-manager@1`.

Concrete error codes use one of these stable prefixes. Codes may be added within a category; removing or changing a code's meaning requires a manager contract major version.

- `MANIFEST_*`: malformed or unsupported manifest/schema data.
- `COMPATIBILITY_*`: manager, host profile, dsh, slot kind, or slot scope mismatch.
- `INTEGRITY_*`: missing, malformed, or mismatched digest.
- `PATH_*`: absolute, traversal, duplicate-normalized, symlink escape, or unsafe path.
- `DEPENDENCY_*`: malformed, missing, or unsatisfied package dependency.
- `CAPABILITY_*`: missing, incompatible, denied, or revoked host capability.
- `PREPARE_*`: staged context creation or preload preparation failure.
- `ACTIVATE_*`: staged mount or activation failure.
- `HEALTH_*`: readiness or required-context acknowledgement failure.
- `TIMEOUT_*`: bounded lifecycle deadline exceeded.
- `RUNTIME_*`: post-commit component failure.
- `DISPOSE_*`: disposer failure or remaining effect-ledger entry.
- `PERSISTENCE_*`: atomic state read/write failure or corrupt state.
- `RECOVERY_*`: rollback or known-good recovery failure.

## Two namespaces

The list above governs `FaultEvent.errorCode`, which is what gets persisted, and `isErrorCode` enforces it.

A second, finer namespace exists at the input boundary and is **never** persisted as a fault code: the archive
reader (`ARCHIVE_*`, `ARTIFACT_*`), the manifest validator (`ASSET_*`, `CONTRIBUTION_*`) and the installer throw
these as `ArchiveError.code`, `ArtifactError.code` or `InstallError.code` so a caller can branch on an exact
cause the fourteen categories cannot express.

`toFaultCode` folds each family onto its owning category on the way into the log — `ARCHIVE_*` and `ARTIFACT_*`
to `INTEGRITY_ARCHIVE`, `ASSET_*` to `MANIFEST_ASSETS`, `CONTRIBUTION_*` to `MANIFEST_CONTRIBUTION`, anything
unrecognised to `RUNTIME_FAILURE` — and the manager appends the source code to the fault message, so the log
line and the thrown error describe the same event without the log carrying an illegal code. A new family
therefore needs an entry in `FAULT_CODE_FAMILIES` in `src/contracts/validation.ts`; without one it is reported
as `RUNTIME_FAILURE`, which is true but unhelpful.
