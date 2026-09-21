export const CONTRACT_VERSION = "dsh-ui-skin-manager@1" as const;
export const MANIFEST_API_VERSION = "dsh.eac.ui-skin/v1" as const;
export const MANIFEST_KIND = "SkinPackage" as const;
export const HOST_PROFILE_ID = "dsh-desktop-eac-ui-skin-profile" as const;
export const MANIFEST_SCHEMA_ID = "https://dsh-eac.github.io/schemas/ui-skin/v1/skin-package.schema.json" as const;

export const ERROR_CATEGORIES = [
  "MANIFEST", "COMPATIBILITY", "INTEGRITY", "PATH", "DEPENDENCY",
  "CAPABILITY", "PREPARE", "ACTIVATE", "HEALTH", "TIMEOUT",
  "RUNTIME", "DISPOSE", "PERSISTENCE", "RECOVERY"
] as const;
