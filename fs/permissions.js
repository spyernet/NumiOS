import { NumiOSError } from '../core/errors.js';

export function modeAllows(node, identity, requested = 'read') {
  const mode = Number(node?.mode ?? 0o644);
  if (identity?.capabilities?.includes?.('*') || identity?.capabilities?.includes?.('system.admin')) return true;
  const ownerId = identity?.uid || identity?.id || 'anonymous';
  const bits = ownerId === node?.owner ? (mode >> 6) & 7 : mode & 7;
  const required = requested === 'read' ? 4 : requested === 'write' ? 2 : requested === 'execute' ? 1 : requested === 'readwrite' ? 6 : 0;
  return (bits & required) === required;
}

export function assertMode(node, identity, requested) {
  if (!modeAllows(node, identity, requested)) throw new NumiOSError('FS_PERMISSION_DENIED', 'Filesystem mode bits deny this operation.', { operation: requested, owner: node?.owner });
}

export function parseMode(mode) {
  if (typeof mode === 'number' && Number.isInteger(mode) && mode >= 0 && mode <= 0o7777) return mode;
  if (typeof mode === 'string' && /^[0-7]{3,4}$/.test(mode)) return Number.parseInt(mode, 8);
  throw new NumiOSError('INVALID_ARGUMENT', 'File mode must be an integer or octal string.');
}
