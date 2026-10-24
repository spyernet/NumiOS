export const libc = Object.freeze({
  atoi(value) { const result = Number.parseInt(String(value).trim(), 10); return Number.isNaN(result) ? 0 : result; },
  itoa(value) { if (!Number.isSafeInteger(Number(value))) throw new TypeError('itoa expects an integer'); return String(Number(value)); },
  strlen(value) { return new TextEncoder().encode(String(value)).length; },
  strcmp(left, right) { const a = String(left); const b = String(right); return a < b ? -1 : a > b ? 1 : 0; },
  memcpy(destination, source, length = source.length) { const size = Math.min(length, destination.length, source.length); destination.set(source.subarray(0, size)); return destination; },
  memset(destination, value, length = destination.length) { destination.fill(value & 255, 0, Math.min(length, destination.length)); return destination; },
  errno(error) { return error?.code || 'UNKNOWN_ERROR'; }
});
