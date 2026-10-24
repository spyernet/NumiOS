import { EventHub } from '../core/events.js';
import { createId } from '../core/ids.js';
import { NumiOSError } from '../core/errors.js';
import { basename, normalizePath, relativePath, isWithinPath } from './path.js';
import { MountManager } from './mounts/mount-manager.js';

const MAX_READ_BYTES = 32 * 1024 * 1024;

/** Kernel-owned namespace and descriptor table. Application APIs reach it only through syscalls. */
export class VirtualFileSystem {
  constructor({ mountManager = new MountManager(), events = new EventHub(), maxHandlesPerProcess = 256 } = {}) {
    this.mountManager = mountManager;
    this.events = events;
    this.maxHandlesPerProcess = maxHandlesPerProcess;
    this.descriptors = new Map();
    this.nextFd = 3;
  }

  async mount(filesystem, mountPoint, options = {}) {
    const path = normalizePath(mountPoint);
    if (path !== '/') {
      const parent = await this.stat(path);
      if (parent.type !== 'directory') throw new NumiOSError('NOT_A_DIRECTORY', 'Mount point must be an existing directory.', { mountPoint: path });
    }
    const record = await this.mountManager.mount(filesystem, path, options);
    this.events.emit('mount', record);
    return record;
  }

  async unmount(mountPoint, options = {}) {
    const path = normalizePath(mountPoint);
    const opened = [...this.descriptors.values()].filter(record => isWithinPath(record.path, path));
    if (opened.length && !options.force) throw new NumiOSError('MOUNT_BUSY', 'Open file descriptors prevent unmounting.', { openHandles: opened.length });
    if (options.force) for (const [fd, record] of this.descriptors) if (isWithinPath(record.path, path)) this.#dropDescriptor(fd, record);
    const record = await this.mountManager.unmount(path, options);
    this.events.emit('unmount', record);
    return record;
  }

  mounts() { return this.mountManager.list(); }

  async stat(path, options = {}) {
    const normalized = normalizePath(path);
    const resolved = this.mountManager.resolve(normalized);
    const stat = await resolved.filesystem.stat(resolved.relativePath, options);
    return { ...stat, path: normalized, name: basename(normalized) === '/' ? '' : basename(normalized) };
  }

  async readdir(path, options = {}) {
    const normalized = normalizePath(path);
    const resolved = this.mountManager.resolve(normalized);
    const entries = await resolved.filesystem.readdir(resolved.relativePath, options);
    return entries.map(entry => ({ ...entry, path: normalizePath(`${normalized === '/' ? '' : normalized}/${entry.name}`) }));
  }

  async readFile(path, options = {}) {
    const resolved = this.mountManager.resolve(path);
    return resolved.filesystem.readFile(resolved.relativePath, options);
  }

  async writeFile(path, data, options = {}) {
    const resolved = this.mountManager.resolve(path);
    this.#assertWritable(resolved.mount);
    const stat = await resolved.filesystem.writeFile(resolved.relativePath, data, options);
    this.events.emit('change', { type: 'write', path: normalizePath(path), stat });
    return stat;
  }

  async mkdir(path, options = {}) {
    const resolved = this.mountManager.resolve(path);
    this.#assertWritable(resolved.mount);
    const stat = await resolved.filesystem.mkdir(resolved.relativePath, options);
    this.events.emit('change', { type: 'mkdir', path: normalizePath(path), stat });
    return stat;
  }

  async unlink(path, options = {}) {
    const resolved = this.mountManager.resolve(path);
    this.#assertWritable(resolved.mount);
    const result = await resolved.filesystem.unlink(resolved.relativePath, options);
    this.events.emit('change', { type: 'unlink', path: normalizePath(path), result });
    return result;
  }

  async rename(from, to, options = {}) {
    const sourcePath = normalizePath(from);
    const targetPath = normalizePath(to);
    const source = this.mountManager.resolve(sourcePath);
    const target = this.mountManager.resolve(targetPath);
    if (source.mount.id !== target.mount.id) throw new NumiOSError('CROSS_DEVICE_OPERATION', 'Rename across filesystem mounts is not atomic and is not supported.');
    this.#assertWritable(source.mount);
    const stat = await source.filesystem.rename(source.relativePath, target.relativePath, options);
    for (const [fd, record] of this.descriptors) {
      if (record.mountId === source.mount.id && isWithinPath(record.path, sourcePath)) {
        record.path = `${targetPath}${record.path.slice(sourcePath.length)}`;
      }
    }
    this.events.emit('change', { type: 'rename', from: sourcePath, to: targetPath, stat });
    return stat;
  }

  async copy(from, to, options = {}) {
    const source = this.mountManager.resolve(from);
    const target = this.mountManager.resolve(to);
    if (source.mount.id !== target.mount.id) throw new NumiOSError('CROSS_DEVICE_OPERATION', 'Copy across mounts is not supported by this implementation.');
    this.#assertWritable(target.mount);
    const result = await source.filesystem.copy(source.relativePath, target.relativePath, options);
    this.events.emit('change', { type: 'copy', from: normalizePath(from), to: normalizePath(to), result });
    return result;
  }

  async resolve(path) {
    const normalized = normalizePath(path);
    const resolved = this.mountManager.resolve(normalized);
    return { path: normalized, mount: { ...this.mountManager.get(resolved.mount.mountPoint) }, relativePath: resolved.relativePath, stat: await this.stat(normalized) };
  }

  async realpath(path) {
    const normalized = normalizePath(path);
    const resolved = this.mountManager.resolve(normalized);
    const real = await resolved.filesystem.realpath(resolved.relativePath);
    return resolved.mount.mountPoint === '/' ? real : normalizePath(`${resolved.mount.mountPoint}/${real}`);
  }

  async access(path, options = {}) {
    const resolved = this.mountManager.resolve(path);
    if (resolved.mount.readOnly && ['write', 'readwrite'].includes(options.mode)) return false;
    if (typeof resolved.filesystem.access === 'function') return resolved.filesystem.access(resolved.relativePath, options);
    await resolved.filesystem.stat(resolved.relativePath);
    return true;
  }

  async chmod(path, mode, options = {}) {
    const resolved = this.mountManager.resolve(path);
    this.#assertWritable(resolved.mount);
    if (typeof resolved.filesystem.chmod !== 'function') throw new NumiOSError('NOT_SUPPORTED', 'This filesystem does not support chmod.');
    const stat = await resolved.filesystem.chmod(resolved.relativePath, mode, options);
    this.events.emit('change', { type: 'chmod', path: normalizePath(path), stat });
    return stat;
  }

  async symlink(target, path, options = {}) {
    const resolved = this.mountManager.resolve(path);
    this.#assertWritable(resolved.mount);
    if (typeof resolved.filesystem.symlink !== 'function') throw new NumiOSError('NOT_SUPPORTED', 'This filesystem does not support symbolic links.');
    const stat = await resolved.filesystem.symlink(target, resolved.relativePath, options);
    this.events.emit('change', { type: 'symlink', path: normalizePath(path), stat });
    return stat;
  }

  async open(path, { mode = 'read', create = false, truncate = false, identity = null } = {}) {
    const normalized = normalizePath(path);
    if (!['read', 'write', 'readwrite', 'append'].includes(mode)) throw new NumiOSError('INVALID_ARGUMENT', 'File open mode must be read, write, readwrite, or append.');
    const key = processKey(identity);
    const count = [...this.descriptors.values()].filter(record => record.processKey === key).length;
    if (count >= this.maxHandlesPerProcess) throw new NumiOSError('RESOURCE_LIMIT', 'The process file descriptor limit has been reached.');
    const resolved = this.mountManager.resolve(normalized);
    if (mode !== 'read') this.#assertWritable(resolved.mount);
    let fileStat;
    try { fileStat = await resolved.filesystem.stat(resolved.relativePath); }
    catch (error) {
      if (error.code !== 'NOT_FOUND' || !create || mode === 'read') throw error;
      await resolved.filesystem.writeFile(resolved.relativePath, new Uint8Array(), { create: true, identity });
      fileStat = await resolved.filesystem.stat(resolved.relativePath);
    }
    if (fileStat.type !== 'file' && fileStat.type !== 'device') throw new NumiOSError('IS_A_DIRECTORY', 'File descriptors may only be opened for regular files or virtual devices.');
    const accessMode = mode === 'read' ? 'read' : mode === 'readwrite' ? 'readwrite' : 'write';
    if (typeof resolved.filesystem.access === 'function' && fileStat.type === 'file') await resolved.filesystem.access(resolved.relativePath, { identity, mode: accessMode });
    if (truncate && mode !== 'read' && fileStat.type === 'file') await resolved.filesystem.writeFile(resolved.relativePath, new Uint8Array(), { create: false, identity });
    const fd = this.nextFd++;
    const record = { fd, processKey: key, processId: identity?.processId ?? identity?.pid ?? null, mountId: resolved.mount.id, path: normalized, mode, device: fileStat.type === 'device', offset: 0, openedAt: Date.now() };
    this.descriptors.set(fd, record);
    this.events.emit('open', { fd, path: normalized, processId: record.processId });
    return { fd, path: normalized, mode, stat: { ...fileStat, path: normalized, name: basename(normalized) } };
  }

  async read(fd, { length = 64 * 1024, offset = undefined, signal = undefined, identity = null } = {}) {
    const record = this.#descriptor(fd);
    this.#assertDescriptorOwner(record, identity);
    if (!['read', 'readwrite'].includes(record.mode)) throw new NumiOSError('BAD_FILE_DESCRIPTOR', 'Descriptor was not opened for reading.', { fd });
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_READ_BYTES) throw new NumiOSError('INVALID_ARGUMENT', `Read length must be between 0 and ${MAX_READ_BYTES}.`);
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    const resolved = this.mountManager.resolve(record.path);
    const data = await resolved.filesystem.readFile(resolved.relativePath, { length, signal, identity });
    if (record.device) { record.offset += data.byteLength; return data.slice(0, length); }
    const start = offset === undefined ? record.offset : checkOffset(offset);
    const chunk = data.slice(start, start + length);
    record.offset = start + chunk.byteLength;
    return chunk;
  }

  async write(fd, input, { offset = undefined, signal = undefined, identity = null } = {}) {
    const record = this.#descriptor(fd);
    this.#assertDescriptorOwner(record, identity);
    if (!['write', 'readwrite', 'append'].includes(record.mode)) throw new NumiOSError('BAD_FILE_DESCRIPTOR', 'Descriptor was not opened for writing.', { fd });
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    const resolved = this.mountManager.resolve(record.path);
    this.#assertWritable(resolved.mount);
    const incoming = toBytes(input);
    if (incoming.byteLength > MAX_READ_BYTES) throw new NumiOSError('RESOURCE_LIMIT', 'A single write exceeds the maximum supported size.');
    if (record.device) {
      const result = await resolved.filesystem.writeFile(resolved.relativePath, incoming, { signal, identity });
      record.offset += incoming.byteLength;
      return { bytesWritten: incoming.byteLength, deviceResult: result };
    }
    const old = await resolved.filesystem.readFile(resolved.relativePath);
    const start = record.mode === 'append' ? old.byteLength : offset === undefined ? record.offset : checkOffset(offset);
    if (start + incoming.byteLength > MAX_READ_BYTES) throw new NumiOSError('RESOURCE_LIMIT', 'File descriptor write exceeds the maximum supported file size.');
    const next = new Uint8Array(Math.max(old.byteLength, start + incoming.byteLength));
    next.set(old);
    next.set(incoming, start);
    const stat = await resolved.filesystem.writeFile(resolved.relativePath, next, { create: false, identity });
    record.offset = start + incoming.byteLength;
    this.events.emit('change', { type: 'write', path: record.path, stat });
    return { bytesWritten: incoming.byteLength, stat };
  }

  close(fd, { identity = null } = {}) {
    const record = this.#descriptor(fd);
    this.#assertDescriptorOwner(record, identity);
    this.#dropDescriptor(fd, record);
    return { closed: true, fd };
  }

  descriptorPath(fd, identity = null) {
    const record = this.#descriptor(fd);
    this.#assertDescriptorOwner(record, identity);
    return record.path;
  }

  closeProcess(identityOrPid) {
    const key = typeof identityOrPid === 'object' ? processKey(identityOrPid) : `pid:${identityOrPid}`;
    let closed = 0;
    for (const [fd, record] of [...this.descriptors]) {
      if (record.processKey === key || record.processId === identityOrPid) {
        this.#dropDescriptor(fd, record);
        closed += 1;
      }
    }
    return closed;
  }

  watch(listener, { signal } = {}) {
    const unsubscribe = this.events.on('change', listener);
    if (signal) {
      if (signal.aborted) unsubscribe();
      else signal.addEventListener('abort', unsubscribe, { once: true });
    }
    return unsubscribe;
  }

  handleCount() { return this.descriptors.size; }

  #descriptor(fd) {
    const record = this.descriptors.get(fd);
    if (!record) throw new NumiOSError('BAD_FILE_DESCRIPTOR', 'File descriptor is not open.', { fd });
    return record;
  }

  #assertDescriptorOwner(record, identity) {
    if (record.processKey !== processKey(identity)) throw new NumiOSError('BAD_FILE_DESCRIPTOR', 'File descriptor belongs to another process.', { fd: record.fd });
  }

  #dropDescriptor(fd, record) {
    this.descriptors.delete(fd);
    this.events.emit('close', { fd, path: record.path, processId: record.processId });
  }

  #assertWritable(mount) {
    if (mount.readOnly) throw new NumiOSError('READ_ONLY_FILESYSTEM', 'The target filesystem is mounted read-only.', { mountPoint: mount.mountPoint });
  }
}

function processKey(identity) {
  if (identity?.processId !== undefined) return `pid:${identity.processId}`;
  if (identity?.pid !== undefined) return `pid:${identity.pid}`;
  return `principal:${identity?.id || 'system'}`;
}

function checkOffset(offset) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new NumiOSError('INVALID_ARGUMENT', 'File offset must be a non-negative safe integer.');
  return offset;
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input === 'string') return new TextEncoder().encode(input);
  throw new NumiOSError('INVALID_ARGUMENT', 'Filesystem data must be text or bytes.');
}

export function decodeFileData(value, encoding = 'bytes') {
  if (!(value instanceof Uint8Array)) throw new NumiOSError('INVALID_ARGUMENT', 'File data must be a Uint8Array.');
  if (encoding === 'bytes') return value;
  if (encoding === 'text') return new TextDecoder().decode(value);
  if (encoding === 'base64') {
    let binary = '';
    for (const byte of value) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  throw new NumiOSError('INVALID_ARGUMENT', 'Encoding must be bytes, text, or base64.');
}
