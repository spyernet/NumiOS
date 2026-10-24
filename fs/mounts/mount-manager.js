import { createId } from '../../core/ids.js';
import { NumiOSError } from '../../core/errors.js';
import { normalizePath, relativePath, isWithinPath } from '../path.js';
import { assertFilesystemContract } from '../filesystem-contract.js';

export class MountManager {
  constructor() {
    this.mounts = new Map();
  }

  async mount(filesystem, mountPoint, { id = createId('mnt'), type = 'unknown', source = null, readOnly = false, allowRoot = false } = {}) {
    const path = normalizePath(mountPoint);
    if (path === '/' && !allowRoot) throw new NumiOSError('MOUNT_DENIED', 'Replacing the root filesystem is restricted to boot.');
    if (path !== '/' && this.mounts.has(path)) throw new NumiOSError('ALREADY_MOUNTED', 'A filesystem is already mounted at this mount point.', { mountPoint: path });
    if (this.mounts.has('/') && path === '/') throw new NumiOSError('ALREADY_MOUNTED', 'Root filesystem is already mounted.');
    assertFilesystemContract(filesystem);
    await filesystem.ready();
    const mount = Object.freeze({ id, mountPoint: path, filesystem, type, source, readOnly: Boolean(readOnly || filesystem.readOnly), mountedAt: new Date().toISOString() });
    this.mounts.set(path, mount);
    return publicMount(mount);
  }

  async unmount(mountPoint, { force = false } = {}) {
    const path = normalizePath(mountPoint);
    if (path === '/') throw new NumiOSError('MOUNT_DENIED', 'The root filesystem cannot be unmounted.');
    const mount = this.mounts.get(path);
    if (!mount) throw new NumiOSError('NOT_MOUNTED', 'No filesystem is mounted at this path.', { mountPoint: path });
    const dependents = [...this.mounts.values()].filter(candidate => candidate.mountPoint !== path && isWithinPath(candidate.mountPoint, path));
    if (dependents.length && !force) throw new NumiOSError('MOUNT_BUSY', 'Nested mounts must be unmounted first.', { dependents: dependents.map(item => item.mountPoint) });
    if (force) for (const child of dependents.sort((a, b) => b.mountPoint.length - a.mountPoint.length)) this.mounts.delete(child.mountPoint);
    this.mounts.delete(path);
    return publicMount(mount);
  }

  resolve(path) {
    const normalized = normalizePath(path);
    const candidates = [...this.mounts.values()].filter(mount => isWithinPath(normalized, mount.mountPoint)).sort((a, b) => b.mountPoint.length - a.mountPoint.length);
    const mount = candidates[0];
    if (!mount) throw new NumiOSError('MOUNT_NOT_FOUND', 'No filesystem covers this virtual path.', { path: normalized });
    return { mount, filesystem: mount.filesystem, relativePath: relativePath(normalized, mount.mountPoint), path: normalized };
  }

  list() {
    return [...this.mounts.values()].sort((a, b) => a.mountPoint.localeCompare(b.mountPoint)).map(publicMount);
  }

  get(mountPoint) {
    const mount = this.mounts.get(normalizePath(mountPoint));
    return mount ? publicMount(mount) : null;
  }

  rawMounts() { return [...this.mounts.values()]; }
}

function publicMount(mount) {
  return { id: mount.id, mountPoint: mount.mountPoint, type: mount.type, source: mount.source, readOnly: mount.readOnly, mountedAt: mount.mountedAt };
}
