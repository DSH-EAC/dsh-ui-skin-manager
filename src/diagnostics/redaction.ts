import {createHash} from "node:crypto";

// The optional scheme group matters: without it `Authorization: Bearer eyJhbGci...` redacts the word "Bearer"
// and leaves the credential itself in the line.
//
// Neither assertion can be a plain `\b`: `_` is a word character, so `\b` is false inside `access_token=` and
// `client_secret:` - the four spellings an OAuth-facing host actually logs - while an open-ended suffix would
// let `tokenizer=v2` and `secretive:true` be eaten as credentials. Naming the segments a key is built from
// gets both: a credential word joined to other words by `-`/`_` is still a credential, and a word that merely
// begins like one is not.
const CREDENTIAL = /(?<![A-Za-z0-9])([A-Za-z0-9]*[-_])?(token|password|secret|authorization|api[-_]?key|cookie)((?:[-_][A-Za-z0-9]+)*)[ \t]*[=:][ \t]*(?:(?:bearer|basic|digest)[ \t]+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;

// The whole key is put back, only the value is dropped: `client_secret=<redacted>` tells an operator which
// credential failed, `=<redacted>` tells them nothing.
function redactCredential(_match: string, prefix: string | undefined, word: string, suffix: string): string {
  return `${prefix ?? ""}${word}${suffix}=<redacted>`;
}
const BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi;
const WINDOWS_PATH = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"',;]*/g;
// Only a slash-led token that does not continue a word is a filesystem path. Without that boundary
// `regions/session/entry.js`, the single most useful thing a skin fault can say, would be redacted along with
// `/home/operator/.dsh`, and every separator a message can use would have to be enumerated instead.
const POSIX_PATH = /(?<![A-Za-z0-9._~%-])\/(?:[^\s"',\\/]+\/)+[^\s"',\\/]*/g;
const HOME_PATH = /~\/[^\s"',]*/g;

// ADR 0002 section 6: filesystem roots, home directories and credentials never reach persisted diagnostics,
// while package-relative asset paths and SemVer ranges in the message stay readable.
export function redact(message: string): string {
  return message
    .replace(CREDENTIAL, redactCredential)
    .replace(BEARER, "$1<redacted>")
    .replace(WINDOWS_PATH, "<redacted-path>")
    .replace(HOME_PATH, "<redacted-path>")
    .replace(POSIX_PATH, "<redacted-path>");
}

const VISIBLE_FIELDS = /^(packageId|packageVersion|packageDigest|slot|region|regionOrSlot|generation|correlationId|errorCode|lifecycleStage|source|contribution)$/i;

// Package coordinates, slots, generations and error codes stay visible (ADR 0002 section 6); every other
// field is arbitrary package or user data and is reduced to a stable hash instead of being persisted.
//
// A visible name is only a guarantee for the primitive it names. `slot` arriving as `{token: "..."}` is not a
// slot identifier, and passing the object through would ship the credential intact under a name the reviewer
// trusts, so anything structured falls to the hash branch instead.
export function redactDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    const primitive = typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null;
    if (VISIBLE_FIELDS.test(key) && primitive) {
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
