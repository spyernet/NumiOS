/**
 * Mounted filesystem contract. Paths are absolute within the mounted filesystem and already normalized.
 * Implementations may omit chmod/symlinks; the VFS reports NOT_SUPPORTED for those operations.
 * All methods are asynchronous, return cloneable values, honor AbortSignal when doing I/O, and must
 * reject with NumiOSError-compatible stable codes rather than silently succeeding.
 */
export const FILESYSTEM_CONTRACT = Object.freeze([
  'ready', 'stat', 'readdir', 'readFile', 'writeFile', 'mkdir', 'unlink', 'rename', 'copy', 'realpath'
]);

export function assertFilesystemContract(filesystem) {
  const missing = FILESYSTEM_CONTRACT.filter(method => typeof filesystem?.[method] !== 'function');
  if (missing.length) throw new TypeError(`Filesystem adapter is missing: ${missing.join(', ')}`);
  return filesystem;
}
