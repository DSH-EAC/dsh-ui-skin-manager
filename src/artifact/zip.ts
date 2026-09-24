import {deflateRawSync, inflateRawSync} from "node:zlib";

import {isSafePath} from "../contracts/validation.ts";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT_SIZE = 0xffff;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffff_ffff;
const MEBIBYTES = 1024 * 1024;
const MAX_INFLATED_BYTES = 256 * MEBIBYTES;
const MAX_ARCHIVE_BYTES = 512 * MEBIBYTES;
const UNIX_HOST = 3;
const ENCRYPTED_FLAG = 0x0001;
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;
const DEFLATE_METHOD = 8;
const VERSION_MADE_BY = (UNIX_HOST << 8) | 20;
const VERSION_NEEDED = 20;
const FILE_TYPE_BITS = 0xf000;
const SYMLINK_TYPE_BITS = 0xa000;
const DOS_READ_ONLY_ATTR = 0x01;
const DOS_DIRECTORY_ATTR = 0x10;
const MODE_BITS = 0o7777;
const MODE_SHIFT = 16;
const DEFAULT_FILE_MODE = 0o644;
const READ_ONLY_FILE_MODE = 0o444;
const DOS_DIRECTORY_MODE = 0o755;
const WRITABLE_DIRECTORY_MODE = 0o775;
const DEFLATE_LEVEL = 9;
// DOS stamps 2026-01-01 00:00:00. The writer must never read the clock: release CI publishes a whole-archive SHA-256.
const FIXED_MOD_TIME = 0;
const FIXED_MOD_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const CRC_POLYNOMIAL = 0xedb88320;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", {fatal: true});

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? (CRC_POLYNOMIAL ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = buildCrcTable();

// Callers must be able to bound an artifact before they allocate it: reading a 10 GiB `skin.zip` into a
// Uint8Array in order to discover it is over the limit has already ended the host process.
export const ARCHIVE_LIMITS = {
  archiveBytes: MAX_ARCHIVE_BYTES,
  fileBytes: MAX_INFLATED_BYTES,
  totalBytes: MAX_INFLATED_BYTES,
  // A contract-v1 central directory cannot record more members than this even when it is well formed.
  entries: UINT16_MAX
} as const;

export class ArchiveError extends Error {
  public override readonly name = "ArchiveError";
  public readonly code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  directory: boolean;
  mode: number;
  // A returned entry never carries symlink:true, because readZip rejects symlinks outright. The field stays so a future
  // non-throwing variant can report the one fact a caller must act on without changing the record shape.
  symlink: boolean;
}

export interface ZipWriteEntry {
  name: string;
  data: Uint8Array;
  directory?: boolean;
  mode?: number;
}

function tooLarge(detail: string): ArchiveError {
  return new ArchiveError("ARCHIVE_TOO_LARGE", detail);
}

function truncated(detail: string): ArchiveError {
  return new ArchiveError("ARCHIVE_TRUNCATED", detail);
}

function unsafeName(detail: string): ArchiveError {
  return new ArchiveError("ARCHIVE_NAME_UNSAFE", detail);
}

function zip64(detail: string): ArchiveError {
  return new ArchiveError("ARCHIVE_ZIP64_UNSUPPORTED", detail);
}

function crc32(data: Uint8Array): number {
  let crc = UINT32_MAX;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ UINT32_MAX) >>> 0;
}

function percentDecode(name: string): string {
  return name.replace(/%([0-9A-Fa-f]{2})/g, (_, pair: string) => String.fromCharCode(Number.parseInt(pair, 16)));
}

// Entry names are compared exactly: on a case-sensitive filesystem `Theme.css` and `theme.css` are two
// legitimate members. The collision that NTFS would create is rejected at extraction time instead, where the
// write actually happens.
function assertUniqueName(names: Set<string>, name: string): void {
  if (names.has(name)) throw new ArchiveError("ARCHIVE_NAME_DUPLICATE", name);
  names.add(name);
}

function structurallySafe(name: string): boolean {
  return isSafePath(name.replace(/\/$/, ""));
}

// Packages reach the extractor as one normalized name, so a percent-encoded `%2e%2e%2f` traversal is the same escape as
// a literal one. Every encoding layer is peeled before the structural test; a stray `%` in a real name still passes.
function assertSafeName(name: string): void {
  if (!structurallySafe(name)) throw unsafeName(`${JSON.stringify(name)} is not a normalized relative entry name`);
  if (!name.includes("%")) return;
  let peeled = name;
  for (let layer = 0; layer < 3; layer += 1) {
    const next = percentDecode(peeled);
    if (!structurallySafe(next)) throw unsafeName(`${JSON.stringify(name)} hides an unsafe path behind percent-encoding`);
    if (next === peeled) break;
    peeled = next;
  }
}

function decodeName(bytes: Uint8Array, offset: number, length: number): string {
  try {
    return decoder.decode(bytes.subarray(offset, offset + length));
  } catch {
    throw unsafeName("an entry name is not valid UTF-8");
  }
}

interface EocdRecord {
  entries: number;
  size: number;
  offset: number;
}

function findEocd(view: DataView): EocdRecord {
  const lowest = Math.max(0, view.byteLength - (EOCD_SIZE + MAX_COMMENT_SIZE));
  for (let offset = view.byteLength - EOCD_SIZE; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    const commentSize = view.getUint16(offset + 20, true);
    if (offset + EOCD_SIZE + commentSize > view.byteLength) continue;
    if (offset >= 20 && view.getUint32(offset - 20, true) === ZIP64_LOCATOR_SIGNATURE) throw zip64("a ZIP64 end-of-central-directory locator precedes the directory");
    const entries = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 12, true);
    const centralOffset = view.getUint32(offset + 16, true);
    if (entries === UINT16_MAX) throw zip64("the entry count is the ZIP64 sentinel");
    if (size === UINT32_MAX) throw zip64("the central directory size is the ZIP64 sentinel");
    if (centralOffset === UINT32_MAX) throw zip64("the central directory offset is the ZIP64 sentinel");
    return {entries, size, offset: centralOffset};
  }
  throw new ArchiveError("ARCHIVE_SIGNATURE_MISSING", "no end-of-central-directory record");
}

interface CentralRecord {
  name: string;
  nameSize: number;
  directory: boolean;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  extraSize: number;
  commentSize: number;
  external: number;
  hostByte: number;
  localOffset: number;
}

function readCentralRecord(view: DataView, bytes: Uint8Array, offset: number, index: number, centralEnd: number): CentralRecord {
  if (offset + CENTRAL_SIZE > centralEnd) throw truncated(`central directory record ${index} runs past the directory`);
  if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) throw new ArchiveError("ARCHIVE_SIGNATURE_MISSING", `central directory record ${index} has no directory signature`);
  const nameSize = view.getUint16(offset + 28, true);
  const extraSize = view.getUint16(offset + 30, true);
  const commentSize = view.getUint16(offset + 32, true);
  if (offset + CENTRAL_SIZE + nameSize + extraSize + commentSize > centralEnd) throw truncated(`central directory record ${index} runs past the directory`);
  const name = decodeName(bytes, offset + CENTRAL_SIZE, nameSize);
  const compressedSize = view.getUint32(offset + 20, true);
  const uncompressedSize = view.getUint32(offset + 24, true);
  if (compressedSize === UINT32_MAX) throw zip64(`${JSON.stringify(name)} stores a ZIP64 compressed size`);
  if (uncompressedSize === UINT32_MAX) throw zip64(`${JSON.stringify(name)} stores a ZIP64 uncompressed size`);
  return {
    name,
    nameSize,
    directory: name.endsWith("/"),
    flags: view.getUint16(offset + 8, true),
    method: view.getUint16(offset + 10, true),
    crc: view.getUint32(offset + 16, true),
    compressedSize,
    uncompressedSize,
    extraSize,
    commentSize,
    external: view.getUint32(offset + 38, true),
    hostByte: (view.getUint16(offset + 4, true) >>> 8) & 0xff,
    localOffset: view.getUint32(offset + 42, true)
  };
}

// Sizes and the CRC always come from the central directory: a streamer sets general purpose bit 3, zeroes the local
// sizes and appends a data descriptor, so a zeroed local header is not evidence of a truncated record.
function readCompressedPayload(view: DataView, bytes: Uint8Array, record: CentralRecord): Uint8Array {
  if (record.localOffset + LOCAL_SIZE > view.byteLength) throw truncated(`${JSON.stringify(record.name)} has no local header where the directory said`);
  if (view.getUint32(record.localOffset, true) !== LOCAL_SIGNATURE) throw new ArchiveError("ARCHIVE_SIGNATURE_MISSING", `${JSON.stringify(record.name)} has no local file header signature`);
  const nameSize = view.getUint16(record.localOffset + 26, true);
  const extraSize = view.getUint16(record.localOffset + 28, true);
  const start = record.localOffset + LOCAL_SIZE + nameSize + extraSize;
  if (start + record.compressedSize > view.byteLength) throw truncated(`${JSON.stringify(record.name)} payload runs past the archive`);
  return bytes.subarray(start, start + record.compressedSize);
}

function inflatePayload(data: Uint8Array, budget: number, name: string): Uint8Array {
  try {
    return new Uint8Array(inflateRawSync(data, {maxOutputLength: budget}));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.includes("maxOutputLength")) throw tooLarge(`${name} inflates past the ${MAX_INFLATED_BYTES} byte budget`);
    // A deflate stream that cannot be parsed can never satisfy its stored CRC, so it is reported as that failure.
    throw new ArchiveError("ARCHIVE_CRC_MISMATCH", `${name} has an unreadable deflate stream: ${detail}`);
  }
}

function modeOf(record: CentralRecord): number {
  if (record.hostByte !== UNIX_HOST) {
    if (record.directory) return DOS_DIRECTORY_MODE;
    return (record.external & DOS_READ_ONLY_ATTR) === 0 ? DEFAULT_FILE_MODE : READ_ONLY_FILE_MODE;
  }
  return (record.external >>> MODE_SHIFT) & MODE_BITS;
}

export function readZip(bytes: Uint8Array): ZipEntry[] {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw tooLarge(`the archive is larger than ${MAX_ARCHIVE_BYTES} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directory = findEocd(view);
  if (directory.entries === 0) return [];
  const centralEnd = directory.offset + directory.size;
  if (directory.offset > view.byteLength || centralEnd > view.byteLength) throw truncated("the central directory runs past the archive");
  const records: CentralRecord[] = [];
  const names = new Set<string>();
  let declaredTotal = 0;
  let cursor = directory.offset;
  for (let index = 0; index < directory.entries; index += 1) {
    const record = readCentralRecord(view, bytes, cursor, index, centralEnd);
    cursor += CENTRAL_SIZE + record.nameSize + record.extraSize + record.commentSize;
    const name = record.name;
    assertSafeName(name);
    assertUniqueName(names, name);
    if ((record.flags & ENCRYPTED_FLAG) !== 0) throw new ArchiveError("ARCHIVE_ENCRYPTED_UNSUPPORTED", name);
    if (record.method !== STORE_METHOD && record.method !== DEFLATE_METHOD) throw new ArchiveError("ARCHIVE_METHOD_UNSUPPORTED", `${name} uses method ${record.method}`);
    // These packages unpack into a user-writable directory, so a symlink is an escape vector whatever the host byte says.
    if (((record.external >>> MODE_SHIFT) & FILE_TYPE_BITS) === SYMLINK_TYPE_BITS) throw new ArchiveError("ARCHIVE_SYMLINK_REJECTED", name);
    if (record.uncompressedSize > MAX_INFLATED_BYTES) throw tooLarge(`${name} declares ${record.uncompressedSize} uncompressed bytes`);
    declaredTotal += record.uncompressedSize;
    if (declaredTotal > MAX_INFLATED_BYTES) throw tooLarge(`the archive declares more than ${MAX_INFLATED_BYTES} uncompressed bytes`);
    records.push(record);
  }
  // The whole directory is vetted before any payload is touched, so a bomb split across entries never gets inflated.
  const entries: ZipEntry[] = [];
  let inflatedTotal = 0;
  for (const record of records) {
    const name = record.name;
    const payload = readCompressedPayload(view, bytes, record);
    if (record.directory) {
      entries.push({name, data: new Uint8Array(0), directory: true, mode: modeOf(record), symlink: false});
      continue;
    }
    const data = record.method === STORE_METHOD ? payload.slice() : inflatePayload(payload, MAX_INFLATED_BYTES - inflatedTotal, name);
    inflatedTotal += data.byteLength;
    if (inflatedTotal > MAX_INFLATED_BYTES) throw tooLarge(`the archive inflates past ${MAX_INFLATED_BYTES} bytes`);
    if (data.byteLength !== record.uncompressedSize) throw new ArchiveError("ARCHIVE_CRC_MISMATCH", `${name} yields ${data.byteLength} bytes against ${record.uncompressedSize} declared`);
    if (crc32(data) !== record.crc) throw new ArchiveError("ARCHIVE_CRC_MISMATCH", `${name} does not match its stored CRC-32`);
    entries.push({name, data, directory: false, mode: modeOf(record), symlink: false});
  }
  return entries;
}

export function isZip(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  const marker = bytes[2] ?? 0;
  return marker === 0x03 || marker === 0x05 || marker === 0x07;
}

function localHeader(name: Uint8Array, method: number, crc: number, compressedSize: number, uncompressedSize: number): Uint8Array {
  const header = new Uint8Array(LOCAL_SIZE + name.byteLength);
  const view = new DataView(header.buffer);
  view.setUint32(0, LOCAL_SIGNATURE, true);
  view.setUint16(4, VERSION_NEEDED, true);
  view.setUint16(6, UTF8_FLAG, true);
  view.setUint16(8, method, true);
  view.setUint16(10, FIXED_MOD_TIME, true);
  view.setUint16(12, FIXED_MOD_DATE, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, compressedSize, true);
  view.setUint32(22, uncompressedSize, true);
  view.setUint16(26, name.byteLength, true);
  view.setUint16(28, 0, true);
  header.set(name, LOCAL_SIZE);
  return header;
}

function centralDirectoryRecord(name: Uint8Array, method: number, crc: number, compressedSize: number, uncompressedSize: number, external: number, localOffset: number): Uint8Array {
  const record = new Uint8Array(CENTRAL_SIZE + name.byteLength);
  const view = new DataView(record.buffer);
  view.setUint32(0, CENTRAL_SIGNATURE, true);
  view.setUint16(4, VERSION_MADE_BY, true);
  view.setUint16(6, VERSION_NEEDED, true);
  view.setUint16(8, UTF8_FLAG, true);
  view.setUint16(10, method, true);
  view.setUint16(12, FIXED_MOD_TIME, true);
  view.setUint16(14, FIXED_MOD_DATE, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, compressedSize, true);
  view.setUint32(24, uncompressedSize, true);
  view.setUint16(28, name.byteLength, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, external, true);
  view.setUint32(42, localOffset, true);
  record.set(name, CENTRAL_SIZE);
  return record;
}

function endOfCentralDirectory(entries: number, size: number, offset: number): Uint8Array {
  const record = new Uint8Array(EOCD_SIZE);
  const view = new DataView(record.buffer);
  view.setUint32(0, EOCD_SIGNATURE, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entries, true);
  view.setUint16(10, entries, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  view.setUint16(20, 0, true);
  return record;
}

// Deflate only earns its place when it actually shrinks the payload; otherwise the entry is stored verbatim.
function deflateOrOriginal(data: Uint8Array): {method: number; payload: Uint8Array} {
  if (data.byteLength === 0) return {method: STORE_METHOD, payload: data};
  const deflated = deflateRawSync(data, {level: DEFLATE_LEVEL});
  return deflated.byteLength < data.byteLength ? {method: DEFLATE_METHOD, payload: deflated} : {method: STORE_METHOD, payload: data};
}

export function writeZip(entries: Array<ZipWriteEntry>): Uint8Array {
  const bodies: Uint8Array[] = [];
  const records: Uint8Array[] = [];
  const names = new Set<string>();
  let declaredTotal = 0;
  let offset = 0;
  for (const entry of entries) {
    const name = entry.directory === true && !entry.name.endsWith("/") ? `${entry.name}/` : entry.name;
    assertSafeName(name);
    assertUniqueName(names, name);
    const directory = name.endsWith("/");
    const data = directory ? new Uint8Array(0) : entry.data;
    if (data.byteLength > MAX_INFLATED_BYTES) throw tooLarge(`${name} is larger than ${MAX_INFLATED_BYTES} bytes`);
    declaredTotal += data.byteLength;
    if (declaredTotal > MAX_INFLATED_BYTES) throw tooLarge(`the archive holds more than ${MAX_INFLATED_BYTES} uncompressed bytes`);
    const {method, payload} = directory ? {method: STORE_METHOD, payload: data} : deflateOrOriginal(data);
    if (data.byteLength >= UINT32_MAX || payload.byteLength >= UINT32_MAX) throw tooLarge(`${name} needs ZIP64 to record its sizes`);
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const mode = (entry.mode ?? (directory ? WRITABLE_DIRECTORY_MODE : DEFAULT_FILE_MODE)) & MODE_BITS;
    const external = directory ? ((mode << MODE_SHIFT) | DOS_DIRECTORY_ATTR) >>> 0 : (mode << MODE_SHIFT) >>> 0;
    bodies.push(localHeader(nameBytes, method, crc, payload.byteLength, data.byteLength), payload);
    records.push(centralDirectoryRecord(nameBytes, method, crc, payload.byteLength, data.byteLength, external, offset));
    offset += LOCAL_SIZE + nameBytes.byteLength + payload.byteLength;
  }
  if (entries.length > UINT16_MAX) throw tooLarge(`the archive has more than ${UINT16_MAX} entries`);
  const directorySize = records.reduce((sum, record) => sum + record.byteLength, 0);
  const archive = new Uint8Array(offset + directorySize + EOCD_SIZE);
  let cursor = 0;
  for (const body of bodies) {
    archive.set(body, cursor);
    cursor += body.byteLength;
  }
  const directoryOffset = cursor;
  for (const record of records) {
    archive.set(record, cursor);
    cursor += record.byteLength;
  }
  archive.set(endOfCentralDirectory(entries.length, directorySize, directoryOffset), cursor);
  return archive;
}
