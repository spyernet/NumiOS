import { NumiOSError } from '../core/errors.js';
import { normalizePath } from '../fs/path.js';
import { assertFilesystemContract } from '../fs/filesystem-contract.js';

export class DeviceRegistry {
  constructor({ logger = null, networkClient = null, storageStatus = null } = {}) {
    this.logger = logger;
    this.networkClient = networkClient;
    this.storageStatus = storageStatus;
    this.devices = new Map();
    this.consoleRecords = [];
  }

  async initialize() {
    this.register({
      name: 'console', description: 'Structured virtual system console.', capabilities: ['device.read', 'device.write'],
      read: async () => new TextEncoder().encode(this.consoleRecords.map(record => `${record.timestamp} ${record.severity} ${record.message}`).join('\n')),
      write: async data => {
        const message = new TextDecoder().decode(data).slice(0, 8192);
        const record = { timestamp: new Date().toISOString(), severity: 'info', message };
        this.consoleRecords.push(record);
        if (this.consoleRecords.length > 1000) this.consoleRecords.shift();
        await this.logger?.info('device.console', message, { eventCode: 'CONSOLE_WRITE' });
        return data.byteLength;
      }
    });
    this.register({ name: 'null', description: 'Discarding virtual device.', capabilities: ['device.read', 'device.write'], read: async () => new Uint8Array(), write: async data => data.byteLength });
    this.register({ name: 'zero', description: 'Virtual zero-byte source.', capabilities: ['device.read'], read: async ({ length = 4096 } = {}) => new Uint8Array(safeLength(length)) });
    this.register({ name: 'random', description: 'Cryptographically secure random bytes from Web Crypto.', capabilities: ['device.read'], read: async ({ length = 32 } = {}) => {
      if (!globalThis.crypto?.getRandomValues) throw new NumiOSError('API_UNAVAILABLE', 'Web Crypto secure random generation is unavailable.');
      const bytes = new Uint8Array(safeLength(length, 65536));
      for (let offset = 0; offset < bytes.length; offset += 65536) globalThis.crypto.getRandomValues(bytes.subarray(offset, Math.min(bytes.length, offset + 65536)));
      return bytes;
    } });
    this.register({ name: 'network', description: 'Browser Fetch capability information; no raw sockets are exposed.', capabilities: ['device.read'], read: async () => textBytes(JSON.stringify({ fetchAvailable: typeof globalThis.fetch === 'function', rawTcp: false, rawUdp: false, arbitraryBind: false })) });
    this.register({ name: 'storage', description: 'Browser storage and logical disk status.', capabilities: ['device.read'], read: async () => textBytes(JSON.stringify(await this.storageStatus?.() || { available: false } )) });
    this.register({ name: 'timer', description: 'Monotonic and wall-clock browser timer information.', capabilities: ['device.read'], read: async () => textBytes(JSON.stringify({ now: Date.now(), performanceNow: globalThis.performance?.now?.() ?? null })) });
    const clipboard = globalThis.navigator?.clipboard;
    this.register({
      name: 'clipboard', description: 'User-mediated browser clipboard API, when permission and policy allow.',
      available: Boolean(clipboard), capabilities: ['device.read', 'device.write'],
      read: async () => {
        if (!clipboard?.readText) throw new NumiOSError('API_UNAVAILABLE', 'Browser clipboard read is unavailable.');
        try { return textBytes(await clipboard.readText()); }
        catch (error) { throw new NumiOSError('BROWSER_PERMISSION_DENIED', 'Browser denied clipboard read access.', { cause: error.message }); }
      },
      write: async data => {
        if (!clipboard?.writeText) throw new NumiOSError('API_UNAVAILABLE', 'Browser clipboard write is unavailable.');
        try { await clipboard.writeText(new TextDecoder().decode(data)); return data.byteLength; }
        catch (error) { throw new NumiOSError('BROWSER_PERMISSION_DENIED', 'Browser denied clipboard write access.', { cause: error.message }); }
      }
    });
    return this;
  }

  register({ name, description, capabilities = [], available = true, initialize = null, read = null, write = null, dispose = null }) {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name)) throw new NumiOSError('INVALID_ARGUMENT', 'Device name is invalid.');
    if (this.devices.has(name)) throw new NumiOSError('ALREADY_EXISTS', 'Device is already registered.', { name });
    const descriptor = { name, path: `/dev/${name}`, description, capabilities: [...capabilities], available: Boolean(available), state: 'registered', registeredAt: new Date().toISOString() };
    this.devices.set(name, { descriptor, initialize, read, write, dispose });
    return { ...descriptor };
  }

  async initializeDrivers() {
    for (const device of this.devices.values()) {
      if (!device.descriptor.available) { device.descriptor.state = 'unavailable'; continue; }
      try { await device.initialize?.(); device.descriptor.state = 'ready'; }
      catch (error) { device.descriptor.state = 'failed'; device.descriptor.error = error.message; await this.logger?.warn('device', 'Device initialization failed.', { eventCode: 'DEVICE_INIT_FAILED', device: device.descriptor.name, error: error.message }); }
    }
  }

  list() { return [...this.devices.values()].map(item => ({ ...item.descriptor })); }

  async read(name, options = {}) {
    const device = this.#device(name);
    if (!device.descriptor.available || device.descriptor.state === 'unavailable') throw new NumiOSError('DEVICE_UNAVAILABLE', `Device /dev/${name} is unavailable.`);
    if (typeof device.read !== 'function') throw new NumiOSError('DEVICE_NOT_READABLE', 'Device does not support reads.', { name });
    return toBytes(await device.read(options));
  }

  async write(name, data, options = {}) {
    const device = this.#device(name);
    if (!device.descriptor.available || device.descriptor.state === 'unavailable') throw new NumiOSError('DEVICE_UNAVAILABLE', `Device /dev/${name} is unavailable.`);
    if (typeof device.write !== 'function') throw new NumiOSError('DEVICE_NOT_WRITABLE', 'Device does not support writes.', { name });
    return device.write(toBytes(data), options);
  }

  async shutdown() {
    const errors = [];
    for (const device of [...this.devices.values()].reverse()) {
      try { await device.dispose?.(); device.descriptor.state = 'stopped'; }
      catch (error) { errors.push({ device: device.descriptor.name, message: error.message }); }
    }
    return errors;
  }

  #device(name) {
    const device = this.devices.get(name);
    if (!device) throw new NumiOSError('DEVICE_NOT_FOUND', 'Virtual device is not registered.', { name });
    return device;
  }
}

export class DeviceFileSystem {
  constructor(registry) { this.registry = registry; this.readOnly = false; }
  async ready() { return this; }
  async stat(path) {
    const normalized = normalizePath(path);
    if (normalized === '/') return stat('/', 'directory', 0);
    const name = normalized.slice(1);
    const device = this.registry.devices.get(name);
    if (!device || name.includes('/')) throw new NumiOSError('NOT_FOUND', 'Virtual device path does not exist.', { path });
    return stat(normalized, 'device', 0, device.descriptor);
  }
  async readdir(path) {
    if (normalizePath(path) !== '/') throw new NumiOSError('NOT_A_DIRECTORY', 'Virtual device directory has no subdirectories.');
    return this.registry.list().map(device => stat(`/${device.name}`, 'device', 0, device));
  }
  async readFile(path, { length = 4096, signal } = {}) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    const name = normalizePath(path).slice(1);
    return this.registry.read(name, { length, signal });
  }
  async writeFile(path, data, options = {}) {
    const bytesWritten = await this.registry.write(normalizePath(path).slice(1), data, options);
    return { path: normalizePath(path), size: bytesWritten, type: 'device' };
  }
  async mkdir() { throw new NumiOSError('NOT_SUPPORTED', 'The /dev filesystem is virtual and cannot contain directories.'); }
  async unlink() { throw new NumiOSError('PERMISSION_DENIED', 'Virtual devices cannot be unlinked.'); }
  async rename() { throw new NumiOSError('PERMISSION_DENIED', 'Virtual devices cannot be renamed.'); }
  async copy() { throw new NumiOSError('NOT_SUPPORTED', 'Virtual device files cannot be copied.'); }
  async realpath(path) { await this.stat(path); return normalizePath(path); }
}

function safeLength(length, max = 16 * 1024 * 1024) {
  if (!Number.isSafeInteger(length) || length < 0 || length > max) throw new NumiOSError('INVALID_ARGUMENT', 'Device read length is invalid.');
  return length;
}
function textBytes(value) { return new TextEncoder().encode(value); }
function toBytes(value) { if (value instanceof Uint8Array) return value; if (value instanceof ArrayBuffer) return new Uint8Array(value); if (typeof value === 'string') return textBytes(value); throw new NumiOSError('INVALID_ARGUMENT', 'Device data must be bytes or text.'); }
function stat(path, type, size, descriptor = null) { return { id: `dev:${path}`, type, name: path === '/' ? '' : path.slice(path.lastIndexOf('/') + 1), path, size, mode: descriptor?.capabilities?.includes('device.write') ? 0o666 : 0o444, owner: 'system', available: descriptor?.available ?? true, description: descriptor?.description || null, createdAt: null, modifiedAt: null }; }

assertFilesystemContract(DeviceFileSystem.prototype);
