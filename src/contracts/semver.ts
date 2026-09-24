export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

type Operator = "" | "=" | ">" | ">=" | "<" | "<=" | "^" | "~";

interface Comparator {
  operator: Operator;
  version: SemVer;
}

const NUMERIC = /^[0-9]+$/;
const PRERELEASE_IDENTIFIER = /^[0-9A-Za-z-]+$/;
const COMPARATOR = /^(<=|>=|<|>|=|\^|~)?v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)?)?$/;
const VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function build(major: string, minor: string, patch: string, prerelease: string | undefined): SemVer | undefined {
  const numbers = [Number(major), Number(minor), Number(patch)];
  if (numbers.some((part) => !Number.isSafeInteger(part))) return undefined;
  if (prerelease !== undefined && !prerelease.split(".").every((part) => part.length > 0 && PRERELEASE_IDENTIFIER.test(part) && (!NUMERIC.test(part) || part === String(Number(part))))) return undefined;
  return {major: numbers[0]!, minor: numbers[1]!, patch: numbers[2]!, prerelease: prerelease ? prerelease.split(".") : []};
}

export function parseVersion(value: unknown): SemVer | undefined {
  if (typeof value !== "string") return undefined;
  const match = VERSION.exec(value);
  if (!match) return undefined;
  return build(match[1]!, match[2]!, match[3]!, match[4]);
}

export function isValidVersion(value: unknown): value is string {
  return parseVersion(value) !== undefined;
}

export function formatVersion(version: SemVer): string {
  return `${version.major}.${version.minor}.${version.patch}${version.prerelease.length > 0 ? `-${version.prerelease.join(".")}` : ""}`;
}

function parseRangeSet(clause: string): Comparator[] | undefined {
  const tokens = clause.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return undefined;
  const comparators: Comparator[] = [];
  for (const token of tokens) {
    const match = COMPARATOR.exec(token);
    if (!match) return undefined;
    const version = build(match[2]!, match[3]!, match[4]!, match[5]);
    if (!version) return undefined;
    comparators.push({operator: (match[1] ?? "") as Operator, version});
  }
  return comparators;
}

export function parseRange(range: unknown): Comparator[][] | undefined {
  if (typeof range !== "string" || range.trim().length === 0) return undefined;
  const sets: Comparator[][] = [];
  for (const clause of range.split("||")) {
    const comparators = parseRangeSet(clause);
    if (!comparators) return undefined;
    sets.push(comparators);
  }
  return sets;
}

export function isValidRange(value: unknown): value is string {
  return parseRange(value) !== undefined;
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = NUMERIC.test(a);
    const bNumeric = NUMERIC.test(b);
    if (aNumeric && bNumeric) {
      const difference = Number(a) - Number(b);
      if (difference !== 0) return Math.sign(difference);
      continue;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function compareVersions(left: SemVer, right: SemVer): number {
  for (const [a, b] of [[left.major, right.major], [left.minor, right.minor], [left.patch, right.patch]] as const) {
    if (a !== b) return Math.sign(a - b);
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function bump(version: SemVer, level: "major" | "minor"): SemVer {
  return level === "major"
    ? {major: version.major + 1, minor: 0, patch: 0, prerelease: []}
    : {major: version.major, minor: version.minor + 1, patch: 0, prerelease: []};
}

function expandRangeSet(comparators: Comparator[]): Comparator[] {
  const expanded: Comparator[] = [];
  for (const {operator, version} of comparators) {
    if (operator === "^") {
      const upper = version.major > 0 ? bump(version, "major") : version.minor > 0 ? bump(version, "minor") : {major: 0, minor: 0, patch: version.patch + 1, prerelease: []};
      expanded.push({operator: ">=", version}, {operator: "<", version: upper});
      continue;
    }
    if (operator === "~") {
      expanded.push({operator: ">=", version}, {operator: "<", version: bump(version, "minor")});
      continue;
    }
    expanded.push({operator: operator === "" ? "=" : operator, version});
  }
  return expanded;
}

function testComparator(comparator: Comparator, version: SemVer): boolean {
  const comparison = compareVersions(version, comparator.version);
  switch (comparator.operator) {
    case ">": return comparison > 0;
    case ">=": return comparison >= 0;
    case "<": return comparison < 0;
    case "<=": return comparison <= 0;
    default: return comparison === 0;
  }
}

function testRangeSet(version: SemVer, comparators: Comparator[]): boolean {
  if (version.prerelease.length > 0) {
    const declared = comparators.some((comparator) =>
      comparator.version.prerelease.length > 0 &&
      comparator.version.major === version.major &&
      comparator.version.minor === version.minor &&
      comparator.version.patch === version.patch);
    if (!declared) return false;
  }
  return comparators.every((comparator) => testComparator(comparator, version));
}

export function satisfiesVersion(version: string, range: string): boolean {
  const actual = parseVersion(version);
  const sets = parseRange(range);
  if (!actual || !sets) return false;
  return sets.some((set) => testRangeSet(actual, expandRangeSet(set)));
}

export function formatComparator(comparator: Comparator): string {
  return `${comparator.operator}${formatVersion(comparator.version)}`;
}

export function normalizeRange(range: string): string | undefined {
  const sets = parseRange(range);
  if (!sets) return undefined;
  return sets.map((set) => expandRangeSet(set).map(formatComparator).join(" ")).join(" || ");
}
