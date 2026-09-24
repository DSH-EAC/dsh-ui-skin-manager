import assert from "node:assert/strict";

export type JsonSchema = Record<string, any>;

// The published schemas are the contract downstream hosts validate against, so a keyword they use has to mean
// something here. Anything outside this subset would make the drift gate pass vacuously.
const SUPPORTED = new Set([
  "$schema", "$id", "title", "description", "$defs", "$ref",
  "type", "enum", "const", "required", "properties", "additionalProperties", "dependentRequired",
  "items", "minItems", "maxLength", "minLength", "pattern", "minimum", "maximum",
  "format", "allOf", "anyOf", "oneOf", "not"
]);

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const baseName = (id: string): string => id.slice(id.lastIndexOf("/") + 1);

export class SchemaLibrary {
  #docs = new Map<string, JsonSchema>();

  constructor(schemas: JsonSchema[]) {
    for (const schema of schemas) {
      const id = typeof schema.$id === "string" ? schema.$id : assert.fail("a schema in the library must declare $id");
      this.#docs.set(baseName(id), schema);
    }
  }

  get names(): string[] {
    return [...this.#docs.keys()].sort();
  }

  document(name: string): JsonSchema {
    const doc = this.#docs.get(name);
    if (doc === undefined) throw new Error(`unknown schema ${name}`);
    return doc;
  }

  // Only two reference shapes are supported on purpose: a pointer inside the current document and a pointer
  // inside a sibling file. A schema that needs anything else needs a real resolver instead of this gate.
  resolve(ref: string, current: JsonSchema): {doc: JsonSchema; node: JsonSchema} {
    const [file, pointer = ""] = ref.split("#");
    const doc = file === "" || file === undefined ? current : this.document(baseName(file));
    let node: unknown = doc;
    for (const raw of pointer.split("/").filter((segment) => segment.length > 0)) {
      const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      node = (node as Record<string, unknown>)[key];
      assert.notEqual(node, undefined, `${ref} does not resolve inside ${file || "the current schema"}`);
    }
    return {doc, node: node as JsonSchema};
  }
}

/** Walks a schema and returns every keyword it uses, so the gate can refuse an unsupported one. */
const MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs"]);

export function keywordsOf(schema: JsonSchema): Set<string> {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key !== "title" && key !== "description" && key !== "$comment") found.add(key);
      // A subschema map is keyed by data property name, so its keys are never keywords themselves.
      if (MAP_KEYWORDS.has(key)) for (const child of Object.values((value ?? {}) as Record<string, unknown>)) walk(child);
      else if (key !== "dependentRequired") walk(value);
    }
  };
  walk(schema);
  return found;
}

export const unsupportedKeywords = (schema: JsonSchema): string[] => [...keywordsOf(schema)].filter((keyword) => !SUPPORTED.has(keyword)).sort();

/** Returns one string per violation, or an empty list when the instance satisfies the schema. */
export function validateAgainst(schema: JsonSchema, instance: unknown, library: SchemaLibrary, doc: JsonSchema = schema, at = "#"): string[] {
  if (typeof schema.$ref === "string") {
    const resolved = library.resolve(schema.$ref, doc);
    return validateAgainst(resolved.node, instance, library, resolved.doc, at);
  }
  const errors: string[] = [];
  const type = jsonTypeOf(instance);

  if (schema.type !== undefined) {
    const allowed: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.includes(type) && !(allowed.includes("integer") && type === "number" && Number.isSafeInteger(instance))) {
      errors.push(`${at}: type must be ${allowed.join(" or ")}, found ${type}`);
      return errors;
    }
  }
  if (schema.const !== undefined && !same(instance, schema.const)) errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum !== undefined && !(schema.enum as unknown[]).some((candidate) => same(instance, candidate))) errors.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`);
  if (schema.format === "date-time" && !DATE_TIME.test(String(instance))) errors.push(`${at}: must be an ISO-8601 UTC instant`);

  if (type === "string") {
    if (typeof schema.minLength === "number" && (instance as string).length < schema.minLength) errors.push(`${at}: must be at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === "number" && (instance as string).length > schema.maxLength) errors.push(`${at}: must be at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(instance as string)) errors.push(`${at}: must match ${schema.pattern}`);
  }
  if (type === "number" || type === "integer") {
    if (typeof schema.minimum === "number" && (instance as number) < schema.minimum) errors.push(`${at}: must be >= ${schema.minimum}`);
    if (typeof schema.maximum === "number" && (instance as number) > schema.maximum) errors.push(`${at}: must be <= ${schema.maximum}`);
  }

  if (type === "array") {
    const items = instance as unknown[];
    if (typeof schema.minItems === "number" && items.length < schema.minItems) errors.push(`${at}: must declare at least ${schema.minItems} items`);
    if (schema.items !== undefined) items.forEach((item, index) => errors.push(...validateAgainst(schema.items as JsonSchema, item, library, doc, `${at}[${index}]`)));
  }

  if (type === "object") {
    const value = instance as Record<string, unknown>;
    for (const required of (schema.required ?? []) as string[]) {
      if (!Object.hasOwn(value, required)) errors.push(`${at}: is missing ${required}`);
    }
    for (const [key, needs] of Object.entries((schema.dependentRequired ?? {}) as Record<string, string[]>)) {
      if (!Object.hasOwn(value, key)) continue;
      for (const needed of needs) if (!Object.hasOwn(value, needed)) errors.push(`${at}: ${key} requires ${needed}`);
    }
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) errors.push(...validateAgainst(child, value[key], library, doc, `${at}.${key}`));
    }
    if (schema.additionalProperties !== undefined) {
      const extras = Object.keys(value).filter((key) => !Object.hasOwn(properties, key));
      if (schema.additionalProperties === false && extras.length > 0) errors.push(`${at}: ${extras.join(", ")} ${extras.length === 1 ? "is" : "are"} not declared`);
      else if (typeof schema.additionalProperties === "object") {
        for (const key of extras) errors.push(...validateAgainst(schema.additionalProperties as JsonSchema, value[key], library, doc, `${at}.${key}`));
      }
    }
  }

  for (const branch of (schema.allOf ?? []) as JsonSchema[]) errors.push(...validateAgainst(branch, instance, library, doc, at));
  if (schema.anyOf !== undefined) {
    const branches = schema.anyOf as JsonSchema[];
    if (!branches.some((branch) => validateAgainst(branch, instance, library, doc, at).length === 0)) errors.push(`${at}: matches none of the anyOf branches`);
  }
  if (schema.oneOf !== undefined) {
    const matched = (schema.oneOf as JsonSchema[]).filter((branch) => validateAgainst(branch, instance, library, doc, at).length === 0).length;
    if (matched !== 1) errors.push(`${at}: must match exactly one oneOf branch, matched ${matched}`);
  }
  if (schema.not !== undefined && validateAgainst(schema.not as JsonSchema, instance, library, doc, at).length === 0) errors.push(`${at}: matches the not branch`);
  return errors;
}
