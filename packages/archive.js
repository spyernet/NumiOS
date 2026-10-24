import { NumiOSError } from '../core/errors.js';
import { validateRelativeFilePath } from '../fs/path.js';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_ENTRIES = 10000;

export function parseStoredZip(input, { maxArchiveBytes = 32 * 1024 * 1024, maxUnpackedBytes = 64 * 1024 * 1024, maxEntries = MAX_ENTRIES } = {}) {
  const bytes = toBytes(input);
  if (bytes.byteLength > maxArchiveBytes) throw new NumiOSError('PACKAGE_TOO_LARGE', 'NPP archive exceeds the configured compressed-size limit.', { limit: maxArchiveBytes });
  if (bytes.byteLength < 22) throw new NumiOSError('PACKAGE_ARCHIVE_INVALID', 'NPP archive is too short to be a ZIP container.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  if (eocdOffset < 0) throw new NumiOSError('PACKAGE_ARCHIVE_INVALID', 'ZIP end-of-central-directory record was not found.');
  const diskNumber = read16(view, eocdOffset + 4);
  const centralDisk = read16(view, eocdOffset + 6);
  const diskEntries = read16(view, eocdOffset + 8);
  const entryCount = read16(view, eocdOffset + 10);
  const centralSize = read32(view, eocdOffset + 12);
  const centralOffset = read32(view, eocdOffset + 16);
  const commentLength = read16(view, eocdOffset + 20);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== entryCount) throw new NumiOSError('PACKAGE_ARCHIVE_UNSUPPORTED', 'Multi-volume ZIP archives are not supported.');
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new NumiOSError('PACKAGE_ARCHIVE_UNSUPPORTED', 'ZIP64 archives are not supported by NPP v1.');
  if (entryCount > maxEntries) throw new NumiOSError('PACKAGE_TOO_LARGE', 'NPP archive contains too many entries.', { limit: maxEntries });
  if (eocdOffset + 22 + commentLength > bytes.byteLength || centralOffset + centralSize > eocdOffset) throw new NumiOSError('PACKAGE_ARCHIVE_INVALID', 'ZIP directory bounds are inconsistent.');

  const files = new Map();
  const names = new Set();
  let cursor = centralOffset;
  let totalUnpacked = 0;
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (cursor + 46 > centralOffset + centralSize || read32(view, cursor) !== CENTRAL) throw new NumiOSError('PACKAGE_ARCHIVE_INVALID', 'ZIP central directory entry is malformed.');
    const madeBy = read16(view, cursor + 4);
    const flags = read16(view, cursor + 8);
    const compression = read16(view, cursor + 10);
    const expectedCrc = read32(view, cursor + 16);
    const compressedSize = read32(view, cursor + 20);
    const uncompressedSize = read32(view, cursor + 24);
    const nameLength = read16(view, cursor + 28);
    const extraLength = read16(view, cursor + 30);
    const fileCommentLength = read16(view, cursor + 32);
    const startDisk = read16(view, cursor + 34);
    const externalAttributes = read32(view, cursor + 38);
    const localOffset = read32(view, cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + fileCommentLength;
    if (recordEnd > centralOffset + centralSize) throw new NumiOSError('PACKAGE_ARCHIVE_INVALID', 'ZIP central directory bounds are inconsistent.');
    if (startDisk !== 0 || localOffset === 0xffffffff || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new NumiOSError('PACKAGE_ARCHIVE_UNSUPPORTED', 'Multi-volume and ZIP64 entries are not supported.');
    if (flags & 0x0001) throw new NumiOSError('PACKAGE_ARCHIVE_UNSUPPORTED', 'Encrypted ZIP entries are not supported.');
    if (compression !== 0) throw new NumiOSError('PACKAGE_COMPRESSION_UNSUPPORTED', 'NPP v1 supports ZIP STORE (uncompressed) entries only.');
    if (compressedSize !== uncompressedSize) throw new NumiOSError('PACKAGE_ARCHIVE_INVALID', 'Stored ZIP entry has inconsistent sizes.');

    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const rawName = decodeZipName(nameBytes, Boolean(flags & 0x0800));
    const directoryEntry = rawName.endsWith('/');
    const safeName = validateRelativeFilePath(directoryEntry ? rawName.slice(0, -1) : rawName);
    if (names.has(safeName)) throw new NumiOSError('PACKAGE_DUPLICATE_ENTRY', 'NPP archive contains duplicate paths.', { path: safeName });
    names.add(safeName);
    const unixHost = (madeBy >>> 8) === 3;
    const unixMode = unixHost ? (externalAttributes >>> 16) & 0xffff : 0;
    const unixFileType = unixMode & 0xf000;
    if (unixFileType === 0xa000 || unixFileType === 0x6000 || unixFileType === 0x2000 || unixFileType === 0x1000) throw new NumiOSError('PACKAGE_ENTRY_TYPE_DENIED', 'NPP cannot contain symbolic links or special device files.', { path: safeName });
    if (directoryEntry) {
      if (uncompressedSize !== 0) throw new NumiOSError('PACKAGE_ARCHIVE_INVALID', 'Directory entries must not contain data.');
      cursor = recordEnd;
      continue;
    }
    totalUnpacked += uncompressedSize;
    if (totalUnpacked > maxUnpackedBytes) throw new NumiOSError('PACKAGE_TOO_LARGE', 'NPP archive exceeds the configured unpacked-size limit.', { limit: maxUnpackedBytes });
    if (localOffset + 30 > centralOffset || read32(view, localOffset) !== LOCAL) throw new NumiOSError('PACKAGE_ARCHIVE_INVALID', 'ZIP local file header is invalid.', { path: safeName });
    const localNameLength = read16(view, localOffset + 26);
    const localExtraLength = read16(view, localOffset + 28);
    const localName = decodeZipName(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength), Boolean(flags & 0x0800));
    if (localName !== rawName) throw new NumiOSError('PACKAGE_ARCHIVE_INVALID', 'ZIP local and central filenames do not match.', { path: safeName });
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset || dataEnd > bytes.byteLength) throw new NumiOSError('PACKAGE_ARCHIVE_INVALID', 'ZIP file data exceeds the archive bounds.', { path: safeName });
    const fileData = bytes.slice(dataStart, dataEnd);
    if (crc32(fileData) !== expectedCrc) throw new NumiOSError('PACKAGE_CRC_MISMATCH', 'ZIP entry CRC-32 does not match.', { path: safeName });
    files.set(safeName, fileData);
    cursor = recordEnd;
  }
  if (cursor !== centralOffset + centralSize) throw new NumiOSError('PACKAGE_ARCHIVE_INVALID', 'ZIP central directory size does not match its entries.');
  return { files, archiveBytes: bytes.byteLength, unpackedBytes: totalUnpacked, format: 'zip-store' };
}

/** Creates a valid, dependency-free ZIP STORE archive suitable for NPP v1. */
export function createStoredZip(entries) {
  const files = entries instanceof Map ? [...entries] : Object.entries(entries || {});
  if (!files.length || files.length > MAX_ENTRIES) throw new NumiOSError('INVALID_ARGUMENT', 'ZIP requires between 1 and 10000 files.');
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [path, input] of files) {
    const safePath = validateRelativeFilePath(path);
    const name = encoder.encode(safePath);
    const data = toBytes(input);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL, true); localView.setUint16(4, 20, true); localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true); localView.setUint16(10, 0, true); localView.setUint16(12, 0, true);
    localView.setUint32(14, crc, true); localView.setUint32(18, data.length, true); localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true); localView.setUint16(28, 0, true);
    local.set(name, 30); local.set(data, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CENTRAL, true); centralView.setUint16(4, (3 << 8) | 20, true); centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true); centralView.setUint16(10, 0, true); centralView.setUint16(12, 0, true); centralView.setUint16(14, 0, true);
    centralView.setUint32(16, crc, true); centralView.setUint32(20, data.length, true); centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, name.length, true); centralView.setUint16(30, 0, true); centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true); centralView.setUint16(36, 0, true); centralView.setUint32(38, 0o100644 << 16, true); centralView.setUint32(42, offset, true);
    central.set(name, 46); centralParts.push(central);
    offset += local.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, EOCD, true); eocdView.setUint16(4, 0, true); eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, files.length, true); eocdView.setUint16(10, files.length, true); eocdView.setUint32(12, centralSize, true); eocdView.setUint32(16, offset, true); eocdView.setUint16(20, 0, true);
  return concatenate([...localParts, ...centralParts, eocd]);
}

function findEndOfCentralDirectory(view) {
  const start = Math.max(0, view.byteLength - 22 - 65535);
  for (let offset = view.byteLength - 22; offset >= start; offset -= 1) if (read32(view, offset) === EOCD) return offset;
  return -1;
}
function decodeZipName(bytes, utf8) {
  if (!utf8 && bytes.some(byte => byte > 0x7f)) throw new NumiOSError('PACKAGE_ARCHIVE_UNSUPPORTED', 'Non-UTF8 ZIP filenames are not supported by NPP v1.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new NumiOSError('PACKAGE_ARCHIVE_INVALID', 'ZIP entry filename is not valid UTF-8.'); }
}
function read16(view, offset) { if (offset + 2 > view.byteLength) return -1; return view.getUint16(offset, true); }
function read32(view, offset) { if (offset + 4 > view.byteLength) return -1; return view.getUint32(offset, true); }
function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input === 'string') return new TextEncoder().encode(input);
  throw new NumiOSError('INVALID_ARGUMENT', 'ZIP file contents must be text or bytes.');
}
function concatenate(parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
