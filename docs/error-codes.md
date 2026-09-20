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
