import { NumiOSError } from '../core/errors.js';

export function normalizePath(input, cwd = '/') {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\u0000')) {
    throw new NumiOSError('INVALID_PATH', 'A filesystem path must be a non-empty string without NUL characters.');
  }
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw new NumiOSError('INVALID_PATH', 'Working directory must be absolute.');
  const absolute = input.startsWith('/') ? input : `${cwd.replace(/\/$/, '')}/${input}`;
  const parts = [];
  for (const segment of absolute.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) throw new NumiOSError('PATH_ESCAPE', 'Path traversal above the virtual filesystem root is not permitted.');
      parts.pop();
      continue;
    }
    if (segment.length > 255) throw new NumiOSError('PATH_INVALID_COMPONENT', 'A path component exceeds 255 characters.');
    if (segment.includes('\\')) throw new NumiOSError('PATH_INVALID_COMPONENT', 'Backslashes are not valid virtual path separators.');
    parts.push(segment);
  }
  return `/${parts.join('/')}` || '/';
}

export function splitPath(path) {
  const normalized = normalizePath(path);
  return normalized === '/' ? [] : normalized.slice(1).split('/');
}

export function dirname(path) {
  const normalized = normalizePath(path);
  if (normalized === '/') return '/';
  const index = normalized.lastIndexOf('/');
  return index === 0 ? '/' : normalized.slice(0, index);
}

export function basename(path) {
  const normalized = normalizePath(path);
  return normalized === '/' ? '/' : normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function isWithinPath(path, parent) {
  const candidate = normalizePath(path);
  const base = normalizePath(parent);
  return base === '/' || candidate === base || candidate.startsWith(`${base}/`);
}

export function relativePath(path, mountPoint) {
  const candidate = normalizePath(path);
  const mount = normalizePath(mountPoint);
  if (!isWithinPath(candidate, mount)) throw new NumiOSError('MOUNT_NOT_FOUND', 'Path is outside the selected mount.');
  const rest = mount === '/' ? candidate : candidate.slice(mount.length);
  return rest || '/';
}

export function validateRelativeFilePath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || path.includes('\u0000')) {
    throw new NumiOSError('PACKAGE_PATH_INVALID', 'Package paths must be safe relative paths.');
  }
  const pieces = path.split('/');
  if (pieces.some(piece => !piece || piece === '.' || piece === '..')) {
    throw new NumiOSError('PACKAGE_PATH_INVALID', 'Package paths cannot contain empty, dot, or parent segments.');
  }
  if (pieces.some(piece => piece.length > 255)) throw new NumiOSError('PACKAGE_PATH_INVALID', 'A package path component is too long.');
  return pieces.join('/');
}
