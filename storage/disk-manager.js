import { createId } from '../core/ids.js';
import { NumiOSError } from '../core/errors.js';
import { IndexedDBStore } from './indexeddb-store.js';
import { OPFSStore } from './opfs-store.js';
import { MemoryStore } from './memory-store.js';
import { TreeFileSystem } from '../fs/tree-filesystem.js';
import { AuthorizedDirectoryFileSystem } from '../fs/filesystems/authorized-directory-filesystem.js';
import { RemoteFileSystem } from '../fs/filesystems/remote-filesystem.js';
import { StaticFileSystem } from '../fs/filesystems/static-filesystem.js';

export class DiskManager {
  constructor({ store, vfs, logger = null, coordinator = null } = {}) {
    if (!store || !vfs) throw new NumiOSError('INVALID_ARGUMENT', 'DiskManager requires a store and VFS.');
    this.store = store;
    this.vfs = vfs;
    this.logger = logger;
    this.coordinator = coordinator;
    this.disks = new Map();
    this.persistedDiskIds = new Set();
  }

  register({ id, type, filesystem, label = id, capacity = null, quota = null, backend = type, readOnly = false, metadata = {} }) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) throw new NumiOSError('INVALID_ARGUMENT', 'Disk id is invalid.');
    if (this.disks.has(id)) throw new NumiOSError('ALREADY_EXISTS', 'Disk id is already registered.', { id });
    if (!filesystem || typeof filesystem.ready !== 'function') throw new NumiOSError('INVALID_ARGUMENT', 'Disk requires a filesystem adapter.');
    const disk = {
      id, type, label, filesystem, backend, capacity, quota,
      intrinsicReadOnly: Boolean(readOnly || filesystem.readOnly), readOnly: Boolean(readOnly || filesystem.readOnly),
      state: 'registered', mountPoint: null, registeredAt: new Date().toISOString(), metadata: structuredCloneSafe(metadata)
    };
    this.disks.set(id, disk);
    return publicDisk(disk);
  }

  async create({ id = createId('disk'), type = 'indexeddb', label = id, capacity = null, quota = null, readOnly = false, remote = null, staticFiles = null, persist = true } = {}) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) throw new NumiOSError('INVALID_ARGUMENT', 'Disk id is invalid.');
    if (typeof label !== 'string' || label.length > 128) throw new NumiOSError('INVALID_ARGUMENT', 'Disk label must be a string of at most 128 characters.');
    if (quota !== null && (!Number.isSafeInteger(quota) || quota < 0)) throw new NumiOSError('INVALID_ARGUMENT', 'Disk quota must be a non-negative safe integer.');
    let filesystem;
    let backend = type;
    if (type === 'indexeddb') {
      filesystem = new TreeFileSystem({ store: this.store, prefix: `fs/disks/${id}/`, name: label, readOnly, maxBytes: quota ?? Infinity });
      if (this.store.volatile) backend = 'memory-volatile';
    }
    else if (type === 'memory') filesystem = new TreeFileSystem({ store: new MemoryStore(), prefix: `fs/${id}/`, name: label, readOnly, maxBytes: quota ?? Infinity });
    else if (type === 'opfs') filesystem = new TreeFileSystem({ store: new OPFSStore(), prefix: `disk-${id}/`, name: label, readOnly, maxBytes: quota ?? Infinity });
    else if (type === 'remote') {
      if (!remote) throw new NumiOSError('INVALID_ARGUMENT', 'Remote disk creation requires a remote protocol configuration.');
      filesystem = new RemoteFileSystem({ ...remote, readOnly: readOnly || remote.readOnly });
      backend = 'remote-http-json';
    } else if (type === 'static') {
      filesystem = new StaticFileSystem({ files: staticFiles || new Map(), name: label });
      readOnly = true;
    } else {
      throw new NumiOSError('NOT_SUPPORTED', `Disk backend type ${type} is not supported.`);
    }
    await filesystem.ready();
    const registered = this.register({ id, type, filesystem, label, capacity, quota, backend, readOnly });
    if (persist && !this.store.volatile && ['indexeddb', 'opfs'].includes(type)) {
      this.persistedDiskIds.add(id);
      try { await this.#saveCatalog(); }
      catch (error) { this.persistedDiskIds.delete(id); this.disks.delete(id); throw error; }
    }
    return registered;
  }

  async restorePersistent() {
    const catalog = await this.store.get('disks/catalog');
    if (catalog === undefined) return [];
    if (!Array.isArray(catalog) || catalog.length > 256) throw new NumiOSError('DISK_CATALOG_INVALID', 'Persistent disk catalog is malformed.');
    const restored = [];
    for (const record of catalog) {
      if (!record || typeof record.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(record.id)
        || !['indexeddb', 'opfs'].includes(record.type) || typeof record.label !== 'string'
        || (record.quota !== null && record.quota !== undefined && (!Number.isSafeInteger(record.quota) || record.quota < 0))
        || (record.readOnly !== undefined && typeof record.readOnly !== 'boolean')) {
        throw new NumiOSError('DISK_CATALOG_INVALID', 'Persistent disk catalog contains an invalid record.');
      }
      await this.create({ ...record, persist: false });
      this.persistedDiskIds.add(record.id);
      restored.push(this.get(record.id));
    }
    return restored;
  }

  async authorizeDirectory({ id = createId('local'), readOnly = false, handle = null } = {}) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) throw new NumiOSError('INVALID_ARGUMENT', 'Directory disk id is invalid.');
    const filesystem = handle
      ? new AuthorizedDirectoryFileSystem({ handle, readOnly })
      : await AuthorizedDirectoryFileSystem.request({ readOnly });
    await filesystem.ready();
    return this.register({ id, type: 'authorized-directory', filesystem, label: filesystem.handle.name || 'Authorized directory', backend: 'file-system-access', readOnly });
  }

  async mount(id, mountPoint, options = {}) {
    const disk = this.#disk(id);
    if (disk.state === 'mounted') throw new NumiOSError('ALREADY_MOUNTED', 'Disk is already mounted.', { id, mountPoint: disk.mountPoint });
    const mount = await this.vfs.mount(disk.filesystem, mountPoint, {
      ...options, id: `disk:${disk.id}`, type: disk.type, source: disk.id,
      readOnly: disk.intrinsicReadOnly || Boolean(options.readOnly)
    });
    disk.state = 'mounted';
    disk.mountPoint = mount.mountPoint;
    disk.readOnly = mount.readOnly;
    await this.logger?.info('storage', 'Disk mounted.', { eventCode: 'DISK_MOUNTED', diskId: id, mountPoint });
    return { disk: publicDisk(disk), mount };
  }

  async unmount(id, options = {}) {
    const disk = this.#disk(id);
    if (disk.state !== 'mounted') throw new NumiOSError('NOT_MOUNTED', 'Disk is not mounted.', { id });
    const mount = await this.vfs.unmount(disk.mountPoint, options);
    disk.state = 'registered';
    disk.mountPoint = null;
    disk.readOnly = disk.intrinsicReadOnly;
    await this.logger?.info('storage', 'Disk unmounted.', { eventCode: 'DISK_UNMOUNTED', diskId: id });
    return { disk: publicDisk(disk), mount };
  }

  async createAndMount(options) {
    const disk = await this.create(options);
    if (!options.mountPoint) return disk;
    return this.mount(disk.id, options.mountPoint, { readOnly: options.readOnly });
  }

  list() { return [...this.disks.values()].map(publicDisk).sort((a, b) => a.id.localeCompare(b.id)); }

  async status() {
    const storage = await this.store.estimate?.() || { available: false, usage: null, quota: null };
    return { disks: this.list(), storage, mounts: this.vfs.mounts() };
  }

  async mountConfigured(entries = []) {
    const mounted = [];
    for (const entry of entries) {
      const disk = this.disks.get(entry.diskId);
      if (!disk) {
        if (entry.optional) continue;
        throw new NumiOSError('DISK_NOT_FOUND', 'Configured disk is not registered.', { diskId: entry.diskId });
      }
      mounted.push(await this.mount(entry.diskId, entry.mountPoint, { readOnly: entry.readOnly }));
    }
    return mounted;
  }

  async diagnostics() {
    const records = [];
    for (const disk of this.disks.values()) {
      let healthy = true;
      let error = null;
      try { await disk.filesystem.ready(); } catch (cause) { healthy = false; error = cause.message; }
      records.push({ id: disk.id, type: disk.type, state: disk.state, healthy, error, mountPoint: disk.mountPoint, quota: disk.quota, capacity: disk.capacity });
    }
    return { healthy: records.every(record => record.healthy), disks: records };
  }

  get(id) { const disk = this.disks.get(id); return disk ? publicDisk(disk) : null; }
  getFilesystem(id) { return this.#disk(id).filesystem; }

  async #saveCatalog() {
    const records = [...this.persistedDiskIds].map(id => this.disks.get(id)).filter(Boolean).map(disk => ({
      id: disk.id, type: disk.type, label: disk.label, capacity: disk.capacity, quota: disk.quota, readOnly: disk.readOnly
    }));
    await this.store.set('disks/catalog', records);
  }

  #disk(id) {
    const disk = this.disks.get(id);
    if (!disk) throw new NumiOSError('DISK_NOT_FOUND', 'Disk is not registered.', { id });
    return disk;
  }
}

function publicDisk(disk) {
  return {
    id: disk.id, type: disk.type, label: disk.label, backend: disk.backend,
    capacity: disk.capacity, quota: disk.quota, readOnly: disk.readOnly,
    state: disk.state, mountPoint: disk.mountPoint, registeredAt: disk.registeredAt,
    metadata: structuredCloneSafe(disk.metadata)
  };
}
function structuredCloneSafe(value) { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
