export const CONTRACT_VERSION = "dsh-ui-skin-manager@1" as const;
export const MANIFEST_API_VERSION = "dsh.eac.ui-skin/v1" as const;
export const MANIFEST_KIND = "SkinPackage" as const;
export const HOST_PROFILE_ID = "dsh-desktop-eac-ui-skin-profile" as const;
export const MANIFEST_SCHEMA_ID = "https://dsh-eac.github.io/schemas/ui-skin/v1/skin-package.schema.json" as const;

export const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export const ERROR_CATEGORIES = [
  "MANIFEST", "COMPATIBILITY", "INTEGRITY", "PATH", "DEPENDENCY",
  "CAPABILITY", "PREPARE", "ACTIVATE", "HEALTH", "TIMEOUT",
  "RUNTIME", "DISPOSE", "PERSISTENCE", "RECOVERY"
] as const;

// ADR 0002 section 4: a package may request a shorter deadline but cannot raise these maxima.
export const LIFECYCLE_DEADLINES = {
  prepareAndPreload: 10_000,
  activate: 10_000,
  health: 10_000,
  deactivateAndDispose: 10_000,
  forceEnableConfirmation: 30_000
} as const;

// ADR 0002 section 6: rotation and retention are fixed for contract v1.
export const LOG_POLICY = {
  maxFileBytes: 16 * 1024 * 1024,
  retentionDays: 30
} as const;
