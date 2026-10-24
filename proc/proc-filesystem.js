import { NumiOSError } from '../core/errors.js';
import { normalizePath } from '../fs/path.js';
import { assertFilesystemContract } from '../fs/filesystem-contract.js';

export class ProcFilesystem {
  constructor({ providers = {} } = {}) {
    this.providers = providers;
    this.readOnly = true;
    this.startedAt = Date.now();
  }
  async ready() { return this; }
  async stat(path) {
    const normalized = normalizePath(path);
    if (normalized === '/') return stat('/', 'directory', 0);
    const key = normalized.slice(1);
    const provider = this.providers[key];
    if (!provider) throw new NumiOSError('NOT_FOUND', 'Virtual proc entry does not exist.', { path: normalized });
    const value = await provider();
    return stat(normalized, 'file', encode(value).byteLength);
  }
  async readdir(path) {
    if (normalizePath(path) !== '/') throw new NumiOSError('NOT_A_DIRECTORY', 'Proc entry is not a directory.');
    return Object.keys(this.providers).sort().map(key => stat(`/${key}`, 'file', 0));
  }
  async readFile(path) {
    const key = normalizePath(path).slice(1);
    const provider = this.providers[key];
    if (!provider) throw new NumiOSError('NOT_FOUND', 'Virtual proc entry does not exist.', { path });
    return encode(await provider());
  }
  async writeFile() { throw new NumiOSError('READ_ONLY_FILESYSTEM', '/proc is read-only.'); }
  async mkdir() { throw new NumiOSError('READ_ONLY_FILESYSTEM', '/proc is read-only.'); }
  async unlink() { throw new NumiOSError('READ_ONLY_FILESYSTEM', '/proc is read-only.'); }
  async rename() { throw new NumiOSError('READ_ONLY_FILESYSTEM', '/proc is read-only.'); }
  async copy() { throw new NumiOSError('READ_ONLY_FILESYSTEM', '/proc is read-only.'); }
  async realpath(path) { const normalized = normalizePath(path); await this.stat(normalized); return normalized; }
}

function encode(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return new TextEncoder().encode(`${text}\n`);
}
function stat(path, type, size) { return { id: `proc:${path}`, type, name: path === '/' ? '' : path.slice(path.lastIndexOf('/') + 1), path, size, mode: 0o444, owner: 'system', createdAt: null, modifiedAt: new Date().toISOString() }; }

assertFilesystemContract(ProcFilesystem.prototype);
