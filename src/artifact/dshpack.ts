// The `dshpack-ui-skin-container@1` row of docs/ui-skin-cross-repo-interface-versions.md names this behaviour,
// not a field: pack.json declares no interface key in ADR 0001, so recognition is the single `ui-skin`
// content entry below and nothing more.
export const PACK_MANIFEST = "pack.json";

export class ContainerError extends Error {
  readonly code: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ContainerError";
    this.code = code;
  }
}

export interface SkinPayload {
  root: string;
  id: string;
  version: string;
}

const record = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value);

function relativeRoot(path: unknown): string | undefined {
  if (typeof path !== "string" || path.length === 0 || path.includes("\\") || path.includes("\0")) return undefined;
  if (path === ".") return "";
  if (!path.endsWith("/") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return undefined;
  const parts = path.slice(0, -1).split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..") ? path : undefined;
}

// ADR 0001 section 1: a `.dshpack` is transport and provenance only. It must declare exactly one UI Skin
// payload, and the inner package then passes every manager gate as if it had been shipped alone.
export function readContainer(value: unknown): SkinPayload {
  if (!record(value)) throw new ContainerError("MANIFEST_DSHPACK_PACK_INVALID", "pack.json must be an object");
  if (typeof value.id !== "string" || value.id.length === 0) throw new ContainerError("MANIFEST_DSHPACK_PACK_INVALID", "pack.json must declare an id");
  if (typeof value.version !== "string" || value.version.length === 0) throw new ContainerError("MANIFEST_DSHPACK_PACK_INVALID", "pack.json must declare a version");
  if (!Array.isArray(value.contents)) throw new ContainerError("MANIFEST_DSHPACK_PACK_INVALID", "pack.json must declare a contents array");
  if (!value.contents.every((entry: unknown) => record(entry))) throw new ContainerError("MANIFEST_DSHPACK_PACK_INVALID", "every content entry must be an object");
  const skins = value.contents.filter((entry: Record<string, any>) => entry.type === "ui-skin");
  if (skins.length === 0) throw new ContainerError("COMPATIBILITY_DSHPACK_NO_SKIN", "a generic feature pack is not a skin package");
  if (skins.length > 1) throw new ContainerError("COMPATIBILITY_DSHPACK_MULTIPLE_SKINS", `a pack declares ${skins.length} ui-skin payloads, exactly one is allowed`);
  const [skin] = skins as Array<Record<string, unknown>>;
  const root = relativeRoot(skin?.path);
  if (root === undefined) throw new ContainerError("MANIFEST_DSHPACK_PACK_INVALID", "the ui-skin content must declare a relative payload directory");
  return {root, id: value.id, version: value.version};
}

export function stripPayloadRoot(root: string, name: string): string | undefined {
  if (root.length === 0) return name;
  return name.startsWith(root) ? name.slice(root.length) : undefined;
}
