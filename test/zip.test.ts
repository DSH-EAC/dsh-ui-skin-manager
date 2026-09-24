import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";

import {ArchiveError, isZip, readZip, writeZip} from "../src/artifact/zip.ts";

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const EOCD_SIZE = 22;
const UTF8_FLAG = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const MOD_TIME = 0;
const MOD_DATE_2026_01_01 = 0x5c21;
const MEBIBYTES = 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMPTY = new Uint8Array(0);

const text = (value: string): Uint8Array => encoder.encode(value);

// A linear-congruential byte stream leaves deflate nothing to shrink, so the stored code path gets exercised.
function incompressible(seed: number, size: number): Uint8Array {
  const data = new Uint8Array(size);
  let state = seed;
  for (let index = 0; index < size; index += 1) {
    state = (Math.imul(state, 1103515245) + 12345) | 0;
    data[index] = (state >>> 16) & 0xff;
  }
  return data;
}

const viewOf = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const joined = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    joined.set(part, cursor);
    cursor += part.byteLength;
  }
  return joined;
}

function copy(bytes: Uint8Array): Uint8Array {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned;
}

function eocdOffset(archive: Uint8Array): number {
  const offset = archive.byteLength - EOCD_SIZE;
  assert.ok(offset >= 0);
  assert.equal(viewOf(archive).getUint32(offset, true), EOCD_SIGNATURE, "the writer ends with an end-of-central-directory record");
  return offset;
}

function centralRecords(archive: Uint8Array): number[] {
  const view = viewOf(archive);
  const end = eocdOffset(archive);
  const count = view.getUint16(end + 8, true);
  const offset = view.getUint32(end + 16, true);
  let cursor = offset;
  const records: number[] = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(view.getUint32(cursor, true), CENTRAL_SIGNATURE, `central directory record ${index} is intact`);
    records.push(cursor);
    cursor += CENTRAL_SIZE + view.getUint16(cursor + 28, true);
  }
  assert.equal(cursor - offset, view.getUint32(end + 12, true), "the recorded directory size covers every record");
  return records;
}

interface Member {
  name: string;
  header: number;
  dataStart: number;
  record: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  external: number;
}

function members(archive: Uint8Array): Member[] {
  const view = viewOf(archive);
  return centralRecords(archive).map((record) => {
    const nameSize = view.getUint16(record + 28, true);
    const name = decoder.decode(archive.subarray(record + CENTRAL_SIZE, record + CENTRAL_SIZE + nameSize));
    const header = view.getUint32(record + 42, true);
    assert.equal(view.getUint32(header, true), LOCAL_SIGNATURE, `${name} has a local header where the directory says`);
    const localNameSize = view.getUint16(header + 26, true);
    assert.equal(decoder.decode(archive.subarray(header + LOCAL_SIZE, header + LOCAL_SIZE + localNameSize)), name, `${name} local and directory names agree`);
    return {
      name,
      header,
      record,
      dataStart: header + LOCAL_SIZE + localNameSize + view.getUint16(header + 28, true),
      method: view.getUint16(record + 10, true),
      compressedSize: view.getUint32(record + 20, true),
      uncompressedSize: view.getUint32(record + 24, true),
      external: view.getUint32(record + 38, true)
    };
  });
}

function withCentralEdits(archive: Uint8Array, index: number, edits: Array<[field: number, width: number, value: number]>): Uint8Array {
  const patched = copy(archive);
  const view = viewOf(patched);
  const record = centralRecords(patched)[index];
  assert.ok(record !== undefined, `the archive has a central directory record ${index}`);
  for (const [field, width, value] of edits) {
    if (width === 2) view.setUint16(record + field, value, true);
    else view.setUint32(record + field, value, true);
  }
  return patched;
}

function withEocdEdits(archive: Uint8Array, edits: Array<[field: number, width: number, value: number]>): Uint8Array {
  const patched = copy(archive);
  const view = viewOf(patched);
  const end = eocdOffset(patched);
  for (const [field, width, value] of edits) {
    if (width === 2) view.setUint16(end + field, value, true);
    else view.setUint32(end + field, value, true);
  }
  return patched;
}

interface RawMember {
  name?: string;
  nameBytes?: Uint8Array;
  data?: Uint8Array;
  method?: number;
  flags?: number;
  crc?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  external?: number;
  hostByte?: number;
  centralSignature?: number;
  localSignature?: number;
  localOffset?: number;
}

// Hand-assembles archives that `writeZip` refuses to build. CRCs default to zero on purpose: every archive this
// produces has to be rejected before the integrity check runs, so a real checksum would only hide an ordering bug.
function rawZip(members: RawMember[], options: {entries?: number; directorySize?: number; directoryOffset?: number; locator?: boolean; eocd?: boolean} = {}): Uint8Array {
  const bodies: Uint8Array[] = [];
  const records: Uint8Array[] = [];
  let offset = 0;
  for (const member of members) {
    const name = member.nameBytes ?? encoder.encode(member.name ?? "");
    const data = member.data ?? EMPTY;
    const method = member.method ?? METHOD_STORE;
    const compressedSize = member.compressedSize ?? data.byteLength;
    const uncompressedSize = member.uncompressedSize ?? data.byteLength;
    const local = new Uint8Array(LOCAL_SIZE + name.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, member.localSignature ?? LOCAL_SIGNATURE, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, member.flags ?? UTF8_FLAG, true);
    localView.setUint16(8, method, true);
    localView.setUint16(10, MOD_TIME, true);
    localView.setUint16(12, MOD_DATE_2026_01_01, true);
    localView.setUint32(14, member.crc ?? 0, true);
    localView.setUint32(18, compressedSize, true);
    localView.setUint32(22, uncompressedSize, true);
    localView.setUint16(26, name.byteLength, true);
    localView.setUint16(28, 0, true);
    local.set(name, LOCAL_SIZE);
    const central = new Uint8Array(CENTRAL_SIZE + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, member.centralSignature ?? CENTRAL_SIGNATURE, true);
    centralView.setUint16(4, (((member.hostByte ?? 3) << 8) | 20) & 0xffff, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, member.flags ?? UTF8_FLAG, true);
    centralView.setUint16(10, method, true);
    centralView.setUint16(12, MOD_TIME, true);
    centralView.setUint16(14, MOD_DATE_2026_01_01, true);
    centralView.setUint32(16, member.crc ?? 0, true);
    centralView.setUint32(20, compressedSize, true);
    centralView.setUint32(24, uncompressedSize, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(38, (member.external ?? 0) >>> 0, true);
    centralView.setUint32(42, member.localOffset ?? offset, true);
    central.set(name, CENTRAL_SIZE);
    bodies.push(local, data);
    records.push(central);
    offset += local.byteLength + data.byteLength;
  }
  const directory = concat(records);
  if (options.eocd === false) return concat(bodies);
  const eocd = new Uint8Array(EOCD_SIZE);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, EOCD_SIGNATURE, true);
  view.setUint16(8, options.entries ?? members.length, true);
  view.setUint16(10, options.entries ?? members.length, true);
  view.setUint32(12, options.directorySize ?? directory.byteLength, true);
  view.setUint32(16, options.directoryOffset ?? offset, true);
  const parts = [...bodies, directory];
  if (options.locator === true) {
    const locator = new Uint8Array(20);
    new DataView(locator.buffer).setUint32(0, ZIP64_LOCATOR_SIGNATURE, true);
    parts.push(locator);
  }
  parts.push(eocd);
  return concat(parts);
}

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof ArchiveError, `expected an ArchiveError, received ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.name, "ArchiveError");
    assert.ok(error.message.startsWith(`${code}: `), `${error.message} is prefixed with the code`);
    return true;
  };
}

test("round-trips names, payloads, permissions and a nested directory", () => {
  const manifest = text(`${JSON.stringify({metadata: {id: "demo.skin", version: "1.0.0"}})}\n`.repeat(60));
  const entry = text("export const skin = {slot: 'session'};\n".repeat(90));
  const stylesheet = text(".dsh-skin[data-skin='demo'] { color: var(--dsh-accent); }\n");
  const noise = incompressible(11, 4096);
  const archive = writeZip([
    {name: "manifest.json", data: manifest, mode: 0o600},
    {name: "regions", data: EMPTY, directory: true},
    {name: "regions/session/entry.js", data: entry},
    {name: "assets/皮肤/主题.css", data: stylesheet, mode: 0o640},
    {name: "assets/noise.bin", data: noise, mode: 0o755},
    {name: "LICENSE", data: EMPTY, mode: 0o444}
  ]);
  assert.deepEqual(readZip(archive), [
    {name: "manifest.json", data: manifest, directory: false, mode: 0o600, symlink: false},
    {name: "regions/", data: EMPTY, directory: true, mode: 0o775, symlink: false},
    {name: "regions/session/entry.js", data: entry, directory: false, mode: 0o644, symlink: false},
    {name: "assets/皮肤/主题.css", data: stylesheet, directory: false, mode: 0o640, symlink: false},
    {name: "assets/noise.bin", data: noise, directory: false, mode: 0o755, symlink: false},
    {name: "LICENSE", data: EMPTY, directory: false, mode: 0o444, symlink: false}
  ]);
});

test("deflates payloads that shrink and stores the ones that do not", () => {
  const noise = incompressible(3, 2048);
  const archive = writeZip([
    {name: "theme.css", data: text(".a{color:red}\n".repeat(300))},
    {name: "noise.bin", data: noise},
    {name: "empty.json", data: EMPTY},
    {name: "dirs/", data: EMPTY, directory: true}
  ]);
  const methods = new Map(members(archive).map((member) => [member.name, member.method]));
  assert.equal(methods.get("theme.css"), METHOD_DEFLATE);
  assert.equal(methods.get("noise.bin"), METHOD_STORE);
  assert.equal(methods.get("empty.json"), METHOD_STORE);
  assert.equal(methods.get("dirs/"), METHOD_STORE);
  const payloadSizes = new Map(members(archive).map((member) => [member.name, member.compressedSize]));
  assert.ok((payloadSizes.get("theme.css") ?? 0) < text(".a{color:red}\n".repeat(300)).byteLength);
  assert.equal(payloadSizes.get("noise.bin"), noise.byteLength);
});

test("writes byte-identical archives with a fixed timestamp for identical input", () => {
  const fixture = [
    {name: "manifest.json", data: text(JSON.stringify({id: "demo.skin"})), mode: 0o600},
    {name: "regions/session/entry.js", data: text("export default 1;\n".repeat(40))},
    {name: "regions/", data: EMPTY, directory: true}
  ];
  const first = writeZip(fixture);
  const second = writeZip(fixture);
  assert.deepEqual(copy(second), copy(first));
  const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest(second), digest(first));
  for (const member of members(first)) {
    const view = viewOf(first);
    assert.equal(view.getUint16(member.header + 10, true), MOD_TIME, `${member.name} carries a fixed modification time`);
    assert.equal(view.getUint16(member.header + 12, true), MOD_DATE_2026_01_01, `${member.name} carries a fixed modification date`);
    assert.equal(view.getUint16(member.record + 12, true), MOD_TIME);
    assert.equal(view.getUint16(member.record + 14, true), MOD_DATE_2026_01_01);
    assert.equal(1980 + (MOD_DATE_2026_01_01 >>> 9), 2026);
    assert.equal((MOD_DATE_2026_01_01 >>> 5) & 0x0f, 1);
    assert.equal(MOD_DATE_2026_01_01 & 0x1f, 1);
    assert.equal(view.getUint16(member.record + 4, true) >>> 8, 3, `${member.name} claims a UNIX host`);
    assert.ok((view.getUint16(member.record + 8, true) & UTF8_FLAG) !== 0, `${member.name} flags its name as UTF-8`);
  }
});

test("records the directory attributes as a UNIX mode plus the MS-DOS directory bit", () => {
  const archive = writeZip([
    {name: "regions", data: EMPTY, directory: true},
    {name: "regions/session", data: EMPTY, directory: true, mode: 0o770},
    {name: "theme.css", data: text("a{}\n")}
  ]);
  const [directory, nested, file] = members(archive);
  assert.ok(directory && nested && file);
  assert.equal(directory.external, ((0o775 << 16) | 0x10) >>> 0);
  assert.equal(nested.external, ((0o770 << 16) | 0x10) >>> 0);
  assert.equal(file.external, (0o644 << 16) >>> 0);
});

test("reads a streamed archive whose local sizes are zeroed for a data descriptor", () => {
  const source = text("export const skin = 1;\n".repeat(120));
  const archive = writeZip([{name: "regions/session/entry.js", data: source}]);
  const [member] = members(archive);
  assert.ok(member);
  const streamed = copy(archive);
  const view = viewOf(streamed);
  // A streamer cannot know the sizes before it finishes, so it zeroes the local header and sets bit 3.
  view.setUint16(member.header + 6, UTF8_FLAG | 0x0008, true);
  view.setUint32(member.header + 14, 0, true);
  view.setUint32(member.header + 18, 0, true);
  view.setUint32(member.header + 22, 0, true);
  const [entry] = readZip(streamed);
  assert.ok(entry);
  assert.equal(entry.name, "regions/session/entry.js");
  assert.deepEqual(entry.data, source);
});

test("falls back to the MS-DOS attribute mapping when the archive was not made on UNIX", () => {
  const archive = writeZip([
    {name: "theme.css", data: text("a{}\n")},
    {name: "locked.css", data: text("b{}\n")},
    {name: "regions/", data: EMPTY, directory: true}
  ]);
  const dosHost = [{index: 0, external: 0x20, mode: 0o644}, {index: 1, external: 0x01, mode: 0o444}, {index: 2, external: 0x10, mode: 0o755}];
  for (const sample of dosHost) {
    const patched = withCentralEdits(archive, sample.index, [[4, 2, 20], [38, 4, sample.external]]);
    const entry = readZip(patched)[sample.index];
    assert.ok(entry);
    assert.equal(entry.mode, sample.mode, `DOS attribute 0x${sample.external.toString(16)} maps to ${sample.mode.toString(8)}`);
  }
});

test("recognizes an archive by its leading signature and refuses unrelated buffers", () => {
  assert.equal(isZip(writeZip([{name: "manifest.json", data: text("{}")}])), true);
  assert.equal(isZip(rawZip([{name: "manifest.json", data: text("{}")}])), true);
  assert.equal(isZip(rawZip([{name: "theme.css", data: text("a{}\n")}], {eocd: false})), true);
  for (const notZip of [text('{"id":"demo.skin","version":"1.0.0"}'), EMPTY, text("PK"), text("PK\x01\x02"), text("7z\xbc\xaf")]) {
    assert.equal(isZip(notZip), false, `${JSON.stringify(decoder.decode(notZip))} is not an archive`);
  }
});

test("refuses an archive with no end-of-central-directory record", () => {
  assert.throws(() => readZip(text('{"id":"demo.skin"}')), expectCode("ARCHIVE_SIGNATURE_MISSING"));
  assert.throws(() => readZip(writeZip([{name: "theme.css", data: text("a{}\n")}]).subarray(0, LOCAL_SIZE + 11)), expectCode("ARCHIVE_SIGNATURE_MISSING"));
  assert.throws(() => readZip(rawZip([{name: "theme.css", data: text("a{}\n")}], {eocd: false})), expectCode("ARCHIVE_SIGNATURE_MISSING"));
});

test("refuses a central directory signature mismatch", () => {
  const archive = writeZip([{name: "theme.css", data: text("a{}\n")}]);
  assert.throws(() => readZip(withCentralEdits(archive, 0, [[0, 4, CENTRAL_SIGNATURE + 1]])), expectCode("ARCHIVE_SIGNATURE_MISSING"));
});

test("refuses a local header that is not where the directory says", () => {
  const archive = writeZip([{name: "theme.css", data: text("a{}\n")}]);
  const [member] = members(archive);
  assert.ok(member);
  assert.throws(() => readZip(withCentralEdits(archive, 0, [[42, 4, archive.byteLength + 8]])), expectCode("ARCHIVE_TRUNCATED"));
  const directoryOffset = archive.byteLength - EOCD_SIZE - CENTRAL_SIZE - "theme.css".length;
  assert.throws(() => readZip(withCentralEdits(archive, 0, [[42, 4, directoryOffset]])), expectCode("ARCHIVE_SIGNATURE_MISSING"));
});

test("refuses a directory range that runs past the archive", () => {
  const archive = writeZip([{name: "theme.css", data: text("a{}\n")}]);
  assert.throws(() => readZip(withEocdEdits(archive, [[12, 4, archive.byteLength]])), expectCode("ARCHIVE_TRUNCATED"));
  assert.throws(() => readZip(withEocdEdits(archive, [[16, 4, archive.byteLength - 4]])), expectCode("ARCHIVE_TRUNCATED"));
  assert.throws(() => readZip(withEocdEdits(archive, [[12, 4, CENTRAL_SIZE - 1]])), expectCode("ARCHIVE_TRUNCATED"));
});

test("refuses a payload range that runs past the archive", () => {
  const archive = writeZip([{name: "noise.bin", data: incompressible(5, 64)}]);
  const [member] = members(archive);
  assert.ok(member);
  assert.throws(() => readZip(withCentralEdits(archive, 0, [[20, 4, member.compressedSize + 512]])), expectCode("ARCHIVE_TRUNCATED"));
});

test("refuses ZIP64 counters instead of silently mis-reading them", () => {
  const archive = writeZip([{name: "theme.css", data: text("a{}\n")}]);
  const cases: Array<[string, Uint8Array]> = [
    ["entry count", withEocdEdits(archive, [[8, 2, 0xffff]])],
    ["directory size", withEocdEdits(archive, [[12, 4, 0xffff_ffff]])],
    ["directory offset", withEocdEdits(archive, [[16, 4, 0xffff_ffff]])],
    ["uncompressed size", withCentralEdits(archive, 0, [[24, 4, 0xffff_ffff]])],
    ["compressed size", withCentralEdits(archive, 0, [[20, 4, 0xffff_ffff]])],
    ["locator", rawZip([], {locator: true})]
  ];
  for (const [label, buffer] of cases) {
    assert.throws(() => readZip(buffer), expectCode("ARCHIVE_ZIP64_UNSUPPORTED"), `${label} must be reported as ZIP64`);
  }
});

test("refuses an encrypted entry", () => {
  const archive = writeZip([{name: "theme.css", data: text("a{}\n")}]);
  assert.throws(() => readZip(withCentralEdits(archive, 0, [[8, 2, UTF8_FLAG | 0x0001]])), expectCode("ARCHIVE_ENCRYPTED_UNSUPPORTED"));
  assert.throws(() => readZip(rawZip([{name: "theme.css", data: text("a{}\n"), flags: UTF8_FLAG | 0x0001}])), expectCode("ARCHIVE_ENCRYPTED_UNSUPPORTED"));
});

test("refuses a compression method outside stored and deflate", () => {
  for (const method of [1, 6, 9, 12, 14, 20]) {
    assert.throws(() => readZip(rawZip([{name: "theme.css", data: text("a{}\n"), method}])), expectCode("ARCHIVE_METHOD_UNSUPPORTED"), `method ${method} must be refused`);
  }
});

test("refuses a symbolic link even when the host byte denies being UNIX", () => {
  const symlinkMode = 0o120777;
  for (const hostByte of [3, 0]) {
    assert.throws(
      () => readZip(rawZip([{name: "escape", data: text("../../Windows/startup.cmd"), external: (symlinkMode << 16) | 0x10, hostByte}])),
      expectCode("ARCHIVE_SYMLINK_REJECTED"),
      `S_IFLNK from host ${hostByte} must be refused`
    );
  }
});

test("refuses an entry name that could escape the package root", () => {
  const unsafe = ["", "bad\\name.js", "nul\0name.js", "/absolute.js", "C:/absolute.js", "../escape.js", "./theme.css", "regions/../escape.js", "a//b.css", "..%2f..%2fwindows.css", "%2e%2e/style.css", "%252e%252e/style.css", "a%00b.css"];
  for (const name of unsafe) {
    assert.throws(() => writeZip([{name, data: text("a{}\n")}]), expectCode("ARCHIVE_NAME_UNSAFE"), `the writer refuses ${JSON.stringify(name)}`);
    assert.throws(() => readZip(rawZip([{name, data: text("a{}\n")}])), expectCode("ARCHIVE_NAME_UNSAFE"), `the reader refuses ${JSON.stringify(name)}`);
  }
  assert.throws(() => readZip(rawZip([{nameBytes: new Uint8Array([0xff, 0xfe, 0x2e, 0x63, 0x73, 0x73]), data: text("a{}\n")}])), expectCode("ARCHIVE_NAME_UNSAFE"));
});

test("keeps names that only look dangerous out of the rejection list", () => {
  const allowed = ["100%coverage.css", "percent%2fplain.css", "weird name (2).css", "theme-.css", "皮肤/主题.css"];
  const archive = writeZip(allowed.map((name) => ({name, data: text(`/* ${name} */\n`)})));
  assert.deepEqual(readZip(archive).map((entry) => entry.name), allowed);
});

test("refuses two entries that normalize to one name without case-folding", () => {
  assert.throws(() => readZip(rawZip([{name: "theme.css"}, {name: "theme.css"}])), expectCode("ARCHIVE_NAME_DUPLICATE"));
  assert.throws(() => writeZip([{name: "theme.css", data: EMPTY}, {name: "theme.css", data: text("a{}\n")}]), expectCode("ARCHIVE_NAME_DUPLICATE"));
  const cased = writeZip([{name: "Theme.css", data: text("a{}\n")}, {name: "theme.css", data: text("b{}\n")}]);
  assert.deepEqual(readZip(cased).map((entry) => entry.name), ["Theme.css", "theme.css"]);
});

test("refuses an entry that claims more than the inflation budget", () => {
  const bomb = rawZip([{name: "payload.js", data: text("junk"), method: METHOD_DEFLATE, uncompressedSize: 0x7fff_ffff}]);
  assert.throws(() => readZip(bomb), expectCode("ARCHIVE_TOO_LARGE"));
  const split = rawZip([
    {name: "a.js", data: text("junk"), method: METHOD_DEFLATE, uncompressedSize: 200 * MEBIBYTES},
    {name: "b.js", data: text("junk"), method: METHOD_DEFLATE, uncompressedSize: 200 * MEBIBYTES}
  ]);
  assert.throws(() => readZip(split), expectCode("ARCHIVE_TOO_LARGE"));
  assert.throws(() => writeZip([{name: "payload.js", data: new Uint8Array(257 * MEBIBYTES)}]), expectCode("ARCHIVE_TOO_LARGE"));
});

test("refuses a stored payload whose byte was flipped after the archive was signed", () => {
  const noise = incompressible(7, 1024);
  const archive = writeZip([{name: "noise.bin", data: noise}]);
  const [member] = members(archive);
  assert.ok(member);
  const tampered = copy(archive);
  const view = viewOf(tampered);
  view.setUint8(member.dataStart, (view.getUint8(member.dataStart) ^ 0xff) & 0xff);
  assert.throws(() => readZip(tampered), expectCode("ARCHIVE_CRC_MISMATCH"));
});

test("refuses a deflate payload that no longer parses or no longer matches its CRC", () => {
  const archive = writeZip([{name: "theme.css", data: text(".a{color:red}\n".repeat(200))}]);
  const [member] = members(archive);
  assert.ok(member);
  assert.equal(member.method, METHOD_DEFLATE);
  const broken = copy(archive);
  viewOf(broken).setUint8(member.dataStart, 0x00);
  assert.throws(() => readZip(broken), expectCode("ARCHIVE_CRC_MISMATCH"));
  const relabeled = withCentralEdits(archive, 0, [[24, 4, member.uncompressedSize + 1]]);
  assert.throws(() => readZip(relabeled), expectCode("ARCHIVE_CRC_MISMATCH"));
});

test("reads an archive whose payload is a view into a larger buffer", () => {
  const archive = writeZip([{name: "manifest.json", data: text(JSON.stringify({id: "demo.skin"}))}]);
  const padded = new Uint8Array(archive.byteLength + 64);
  padded.set(archive, 64);
  const window = padded.subarray(64, 64 + archive.byteLength);
  assert.notEqual(window.byteOffset, 0);
  assert.deepEqual(readZip(window).map((entry) => entry.name), ["manifest.json"]);
});

test("reads an empty archive as no entries", () => {
  assert.deepEqual(readZip(writeZip([])), []);
  assert.deepEqual(readZip(rawZip([])), []);
});

test("ArchiveError reports its code and formats the message as code: detail", () => {
  const error = new ArchiveError("ARCHIVE_TRUNCATED", "payload runs past the archive");
  assert.ok(error instanceof ArchiveError);
  assert.ok(error instanceof Error);
  assert.equal(error.name, "ArchiveError");
  assert.equal(error.code, "ARCHIVE_TRUNCATED");
  assert.equal(error.message, "ARCHIVE_TRUNCATED: payload runs past the archive");
});
