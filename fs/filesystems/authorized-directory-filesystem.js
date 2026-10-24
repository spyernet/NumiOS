import { NumiOSError } from '../../core/errors.js';
import { normalizePath, splitPath, dirname, basename } from '../path.js';
import { assertFilesystemContract } from '../filesystem-contract.js';

/** Maps only a FileSystemDirectoryHandle explicitly selected by the user into the VFS. */
export class AuthorizedDirectoryFileSystem {
  constructor({ handle, readOnly = false } = {}) {
    if (!handle || typeof handle.getDirectoryHandle !== 'function') throw new NumiOSError('INVALID_ARGUMENT', 'A user-authorized directory handle is required.');
    this.handle = handle;
    this.readOnly = Boolean(readOnly);
    this.permission = 'unknown';
  }

  static async request({ readOnly = false } = {}) {
    if (typeof globalThis.showDirectoryPicker !== 'function') throw new NumiOSError('API_UNAVAILABLE', 'The File System Access API directory picker is not supported.');
    const handle = await globalThis.showDirectoryPicker({ mode: readOnly ? 'read' : 'readwrite' });
    return new AuthorizedDirectoryFileSystem({ handle, readOnly });
  }

  async ready() {
    const mode = this.readOnly ? 'read' : 'readwrite';
    let permission = await this.handle.queryPermission?.({ mode });
    if (permission !== 'granted' && this.handle.requestPermission) permission = await this.handle.requestPermission({ mode });
    if (permission && permission !== 'granted') throw new NumiOSError('USER_PERMISSION_DENIED', 'The user did not grant access to the selected directory.');
    this.permission = permission || 'granted';
    return this;
  }

  async stat(path) {
    const normalized = normalizePath(path);
    if (normalized === '/') return directoryStat('/', this.handle.name || 'directory');
    const entry = await this.#getEntry(normalized);
    if (entry.kind === 'directory') return directoryStat(normalized, entry.name);
    const file = await entry.getFile();
    return { id: `user:${normalized}`, type: 'file', name: entry.name, path: normalized, size: file.size, mode: 0o666, owner: 'user-authorized', createdAt: null, modifiedAt: file.lastModified ? new Date(file.lastModified).toISOString() : null };
  }

  async readdir(path) {
    const directory = await this.#getDirectory(path);
    const result = [];
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind === 'directory') result.push(directoryStat(`${normalizePath(path) === '/' ? '' : normalizePath(path)}/${name}`, name));
      else {
        const file = await handle.getFile();
        result.push({ id: `user:${name}`, type: 'file', name, path: `${normalizePath(path) === '/' ? '' : normalizePath(path)}/${name}`, size: file.size, mode: 0o666, owner: 'user-authorized', createdAt: null, modifiedAt: file.lastModified ? new Date(file.lastModified).toISOString() : null });
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  async readFile(path) {
    const entry = await this.#getEntry(path);
    if (entry.kind !== 'file') throw new NumiOSError('IS_A_DIRECTORY', 'Cannot read a directory.');
    return new Uint8Array(await (await entry.getFile()).arrayBuffer());
  }

  async writeFile(path, input, { create = true, signal } = {}) {
    this.#assertWritable();
    const normalized = normalizePath(path);
    const parent = await this.#getDirectory(dirname(normalized));
    let handle;
    try { handle = await parent.getFileHandle(basename(normalized), { create: Boolean(create) }); }
    catch (error) { throw mapError(error, normalized); }
    const writable = await handle.createWritable({ keepExistingData: false });
    try {
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
      await writable.write(toBytes(input));
      await writable.close();
    } catch (error) {
      await writable.abort?.().catch(() => {});
      throw error;
    }
    return this.stat(normalized);
  }

  async mkdir(path, { recursive = false } = {}) {
    this.#assertWritable();
    const normalized = normalizePath(path);
    if (normalized === '/') return this.stat('/');
    const parts = splitPath(normalized);
    let current = this.handle;
    for (let index = 0; index < parts.length; index += 1) {
      const last = index === parts.length - 1;
      try { current = await current.getDirectoryHandle(parts[index], { create: Boolean(recursive || last) }); }
      catch (error) { throw mapError(error, normalized); }
    }
    return this.stat(normalized);
  }

  async unlink(path, { recursive = false } = {}) {
    this.#assertWritable();
    const normalized = normalizePath(path);
    if (normalized === '/') throw new NumiOSError('PERMISSION_DENIED', 'The selected directory root cannot be removed.');
    const parent = await this.#getDirectory(dirname(normalized));
    try { await parent.removeEntry(basename(normalized), { recursive: Boolean(recursive) }); }
    catch (error) { throw mapError(error, normalized); }
    return { removed: normalized };
  }

  async rename(from, to) {
    this.#assertWritable();
    const source = normalizePath(from);
    const target = normalizePath(to);
    const handle = await this.#getEntry(source);
    if (typeof handle.move !== 'function') throw new NumiOSError('NOT_SUPPORTED', 'This browser does not support safe File System Access handle moves.');
    const targetParent = await this.#getDirectory(dirname(target));
    try { await handle.move(targetParent, basename(target)); }
    catch (error) { throw mapError(error, target); }
    return this.stat(target);
  }

  async copy(from, to) {
    const source = await this.#getEntry(from);
    if (source.kind !== 'file') throw new NumiOSError('NOT_SUPPORTED', 'Directory copy is not supported by the authorized-directory adapter.');
    return this.writeFile(to, await this.readFile(from), { create: true });
  }

  async realpath(path) { const normalized = normalizePath(path); await this.stat(normalized); return normalized; }

  async #getEntry(path) {
    const normalized = normalizePath(path);
    if (normalized === '/') return this.handle;
    const parts = splitPath(normalized);
    let current = this.handle;
    for (let index = 0; index < parts.length; index += 1) {
      const last = index === parts.length - 1;
      try {
        if (!last) current = await current.getDirectoryHandle(parts[index]);
        else {
          try { current = await current.getFileHandle(parts[index]); }
          catch (error) {
            if (error.name !== 'TypeMismatchError') throw error;
            current = await current.getDirectoryHandle(parts[index]);
          }
        }
      } catch (error) { throw mapError(error, normalized); }
    }
    return current;
  }

  async #getDirectory(path) {
    const normalized = normalizePath(path);
    if (normalized === '/') return this.handle;
    try { return await this.handle.getDirectoryHandle(splitPath(normalized).join('/')); }
    catch (error) {
      let current = this.handle;
      for (const segment of splitPath(normalized)) {
        try { current = await current.getDirectoryHandle(segment); }
        catch (nestedError) { throw mapError(nestedError, normalized); }
      }
      return current;
    }
  }

  #assertWritable() {
    if (this.readOnly) throw new NumiOSError('READ_ONLY_FILESYSTEM', 'The authorized directory is mounted read-only.');
    if (this.permission !== 'granted') throw new NumiOSError('USER_PERMISSION_DENIED', 'Directory permission is no longer granted.');
  }
}

function directoryStat(path, name) { return { id: `user:${path}`, type: 'directory', name, path, size: 0, mode: 0o777, owner: 'user-authorized', createdAt: null, modifiedAt: null }; }
function toBytes(input) { if (input instanceof Uint8Array) return input; if (input instanceof ArrayBuffer) return new Uint8Array(input); if (typeof input === 'string') return new TextEncoder().encode(input); throw new NumiOSError('INVALID_ARGUMENT', 'File contents must be text or bytes.'); }
function mapError(error, path) {
  if (error instanceof NumiOSError) return error;
  const code = error?.name === 'NotFoundError' ? 'NOT_FOUND'
    : error?.name === 'TypeMismatchError' ? 'NOT_A_DIRECTORY'
      : error?.name === 'NotAllowedError' ? 'USER_PERMISSION_DENIED'
        : error?.name === 'QuotaExceededError' ? 'STORAGE_QUOTA_EXCEEDED' : 'USER_FILESYSTEM_ERROR';
  return new NumiOSError(code, error?.message || 'File System Access operation failed.', { path });
}

assertFilesystemContract(AuthorizedDirectoryFileSystem.prototype);
