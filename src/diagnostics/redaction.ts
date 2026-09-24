import {createHash} from "node:crypto";

const CREDENTIAL = /\b(token|password|secret|authorization|api[-_]?key|cookie)\b\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi;
const WINDOWS_PATH = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"',;]*/g;
const POSIX_PATH = /\/(?:[^\s"',\\/]+\/)+[^\s"',\\/]*/g;
const HOME_PATH = /~\/[^\s"',]*/g;

// ADR 0002 section 6: filesystem roots, home directories and credentials never reach persisted diagnostics,
// while package-relative asset paths and SemVer ranges in the message stay readable.
export function redact(message: string): string {
  return message
    .replace(CREDENTIAL, "$1=<redacted>")
    .replace(BEARER, "$1<redacted>")
    .replace(WINDOWS_PATH, "<redacted-path>")
    .replace(HOME_PATH, "<redacted-path>")
    .replace(POSIX_PATH, "<redacted-path>");
}

const VISIBLE_FIELDS = /^(packageId|packageVersion|packageDigest|slot|region|regionOrSlot|generation|correlationId|errorCode|lifecycleStage|source|contribution)$/i;

// Package coordinates, slots, generations and error codes stay visible (ADR 0002 section 6); every other
// field is arbitrary package or user data and is reduced to a stable hash instead of being persisted.
export function redactDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (VISIBLE_FIELDS.test(key)) {
      output[key] = typeof value === "string" ? redact(value) : value;
      continue;
    }
    output[key] = `#${createHash("sha256").update(stringify(value)).digest("hex").slice(0, 16)}`;
  }
  return output;
}

function stringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_, entry: unknown) => {
    if (typeof entry === "object" && entry !== null) {
      if (seen.has(entry)) return "[circular]";
      seen.add(entry);
      return entry;
    }
    return typeof entry === "string" ? redact(entry) : entry;
  }) ?? String(value);
}
