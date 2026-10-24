import { NumiOSError } from '../../core/errors.js';
import { normalizePath } from '../path.js';
import { assertFilesystemContract } from '../filesystem-contract.js';

export class StaticFileSystem {
  constructor({ files = new Map(), name = 'static' } = {}) {
    this.name = name;
    this.readOnly = true;
    this.files = new Map();
    this.directories = new Set(['/']);
    for (const [path, value] of files instanceof Map ? files : Object.entries(files)) this.add(path, value);
  }

  add(path, value) {
    const normalized = normalizePath(path);
    if (normalized === '/') throw new NumiOSError('INVALID_PATH', 'Static file path cannot be root.');
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.files.set(normalized, bytes);
    const segments = normalized.split('/').slice(1, -1);
    let current = '';
    for (const segment of segments) { current += `/${segment}`; this.directories.add(current); }
    return this;
  }

  async ready() { return this; }
  async stat(path) {
    const normalized = normalizePath(path);
    if (this.files.has(normalized)) return stat(normalized, 'file', this.files.get(normalized).byteLength);
    if (this.directories.has(normalized)) return stat(normalized, 'directory', 0);
    throw new NumiOSError('NOT_FOUND', 'Static filesystem path does not exist.', { path: normalized });
  }
  async readdir(path) {
    const normalized = normalizePath(path);
    const target = await this.stat(normalized);
    if (target.type !== 'directory') throw new NumiOSError('NOT_A_DIRECTORY', 'Path is not a directory.');
    const names = new Set();
    const prefix = normalized === '/' ? '/' : `${normalized}/`;
    for (const entry of [...this.directories, ...this.files.keys()]) {
      if (!entry.startsWith(prefix)) continue;
      const remainder = entry.slice(prefix.length);
      if (remainder && !remainder.includes('/')) names.add(remainder);
    }
    return [...names].sort().map(name => this.files.has(`${prefix}${name}`)
      ? stat(`${prefix}${name}`, 'file', this.files.get(`${prefix}${name}`).byteLength)
      : stat(`${prefix}${name}`, 'directory', 0));
  }
  async readFile(path) {
    const normalized = normalizePath(path);
    const data = this.files.get(normalized);
    if (!data) {
      if (this.directories.has(normalized)) throw new NumiOSError('IS_A_DIRECTORY', 'Cannot read a directory.');
      throw new NumiOSError('NOT_FOUND', 'Static file does not exist.');
    }
    return data.slice();
  }
  async writeFile() { throw new NumiOSError('READ_ONLY_FILESYSTEM', 'Static filesystem is read-only.'); }
  async mkdir() { throw new NumiOSError('READ_ONLY_FILESYSTEM', 'Static filesystem is read-only.'); }
  async unlink() { throw new NumiOSError('READ_ONLY_FILESYSTEM', 'Static filesystem is read-only.'); }
  async rename() { throw new NumiOSError('READ_ONLY_FILESYSTEM', 'Static filesystem is read-only.'); }
  async copy() { throw new NumiOSError('READ_ONLY_FILESYSTEM', 'Static filesystem is read-only.'); }
  async realpath(path) { const normalized = normalizePath(path); await this.stat(normalized); return normalized; }
}

function stat(path, type, size) {
  return { id: `static:${path}`, type, name: path === '/' ? '' : path.slice(path.lastIndexOf('/') + 1), path, size, mode: type === 'directory' ? 0o555 : 0o444, owner: 'system', createdAt: null, modifiedAt: null };
}

assertFilesystemContract(StaticFileSystem.prototype);
