import { createId } from '../core/ids.js';
import { NumiOSError } from '../core/errors.js';
import { basename, dirname, normalizePath, splitPath } from './path.js';
import { assertMode, parseMode } from './permissions.js';
import { assertFilesystemContract } from './filesystem-contract.js';

const ROOT_ID = 'root';

/** Inode-like tree filesystem persisted through an atomic key/value store. */
export class TreeFileSystem {
  constructor({ store, prefix = 'fs/root/', name = 'numios-root', readOnly = false, maxBytes = Infinity, owner = 'system', clock = () => Date.now() } = {}) {
    if (!store) throw new NumiOSError('INVALID_ARGUMENT', 'TreeFileSystem requires a storage backend.');
    this.store = store;
    this.prefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
    this.name = name;
    this.readOnly = Boolean(readOnly);
    this.maxBytes = maxBytes;
    this.owner = owner;
    this.clock = clock;
    this.readyPromise = null;
  }

  async ready() {
    if (!this.readyPromise) this.readyPromise = this.#initialize();
    return this.readyPromise;
  }

  async #initialize() {
    await this.store.ready?.();
    const root = await this.#getNode(ROOT_ID);
    if (!root) {
      const now = this.#now();
      await this.store.batch([{ type: 'set', key: this.#inodeKey(ROOT_ID), value: {
        id: ROOT_ID, type: 'directory', name: '', parent: null, owner: this.owner, mode: 0o755,
        createdAt: now, modifiedAt: now, size: 0
      } }]);
    }
    const checked = await this.#getNode(ROOT_ID);
    if (checked?.type !== 'directory') throw new NumiOSError('FILESYSTEM_CORRUPT', 'Virtual filesystem root inode is invalid.');
    return this;
  }

  async stat(path, { followSymlinks = true } = {}) {
    await this.ready();
    const { node, path: realPath } = await this.#lookup(path, { followFinal: followSymlinks });
    return publicStat(node, realPath);
  }

  async readdir(path, { identity = null } = {}) {
    await this.ready();
    const { node } = await this.#lookup(path);
    if (node.type !== 'directory') throw new NumiOSError('NOT_A_DIRECTORY', 'The requested path is not a directory.', { path });
    if (identity) assertMode(node, identity, 'read');
    const entries = await this.store.list(this.#entryPrefix(node.id));
    const result = [];
    for (const [key, childId] of entries) {
      const child = await this.#getNode(childId);
      if (child) result.push(publicStat(child, `${normalizePath(path) === '/' ? '' : normalizePath(path)}/${child.name}`));
      else throw new NumiOSError('FILESYSTEM_CORRUPT', 'A directory entry refers to a missing inode.', { key, childId });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  async readFile(path, { identity = null } = {}) {
    await this.ready();
    const { node } = await this.#lookup(path);
    if (node.type === 'directory') throw new NumiOSError('IS_A_DIRECTORY', 'Cannot read a directory as a file.', { path });
    if (node.type === 'symlink') throw new NumiOSError('SYMLINK_UNRESOLVED', 'The symbolic link could not be resolved.', { path });
    if (node.type !== 'file') throw new NumiOSError('NOT_SUPPORTED', `Cannot read filesystem node type ${node.type}.`);
    if (identity) assertMode(node, identity, 'read');
    const data = await this.store.get(this.#contentKey(node.id));
    if (data === undefined) return new Uint8Array();
    return toBytes(data).slice();
  }

  async writeFile(path, input, { create = true, mode = 0o644, owner = this.owner, identity = null } = {}) {
    await this.#assertWritable();
    const normalized = normalizePath(path);
    if (normalized === '/') throw new NumiOSError('IS_A_DIRECTORY', 'Cannot replace the filesystem root with a file.');
    const data = toBytes(input);
    let existing;
    try { existing = await this.#lookup(normalized); }
    catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
    if (existing) {
      const node = existing.node;
      if (node.type === 'directory') throw new NumiOSError('IS_A_DIRECTORY', 'Cannot replace a directory with a file.', { path });
      if (node.type !== 'file') throw new NumiOSError('NOT_SUPPORTED', 'Writing through a symbolic link is not supported by this filesystem method.');
      if (identity) assertMode(node, identity, 'write');
      const used = await this.usageBytes();
      this.#assertCapacity(used, used - node.size + data.byteLength);
      node.size = data.byteLength;
      node.modifiedAt = this.#now();
      await this.store.batch([
        { type: 'set', key: this.#inodeKey(node.id), value: node },
        { type: 'set', key: this.#contentKey(node.id), value: data }
      ]);
      return publicStat(node, normalized);
    }
    if (!create) throw new NumiOSError('NOT_FOUND', 'The requested file does not exist.', { path });
    const parentPath = dirname(normalized);
    const parent = await this.#lookup(parentPath);
    if (parent.node.type !== 'directory') throw new NumiOSError('NOT_A_DIRECTORY', 'The parent path is not a directory.', { parentPath });
    if (identity) assertMode(parent.node, identity, 'write');
    const childName = basename(normalized);
    if (await this.#getEntry(parent.node.id, childName)) throw new NumiOSError('ALREADY_EXISTS', 'A filesystem entry already exists at this path.', { path });
    const used = await this.usageBytes();
    this.#assertCapacity(used, used + data.byteLength);
    const id = createId('ino');
    const now = this.#now();
    const node = { id, type: 'file', name: childName, parent: parent.node.id, owner, mode: parseMode(mode), createdAt: now, modifiedAt: now, size: data.byteLength };
    await this.store.batch([
      { type: 'set', key: this.#inodeKey(id), value: node },
      { type: 'set', key: this.#entryKey(parent.node.id, childName), value: id },
      { type: 'set', key: this.#contentKey(id), value: data }
    ]);
    return publicStat(node, normalized);
  }

  async mkdir(path, { recursive = false, mode = 0o755, owner = this.owner, existOk = false, identity = null } = {}) {
    await this.#assertWritable();
    const normalized = normalizePath(path);
    if (normalized === '/') return this.stat('/');
    const existing = await this.#lookupOptional(normalized);
    if (existing) {
      if (existing.node.type !== 'directory') throw new NumiOSError('ALREADY_EXISTS', 'A non-directory entry already exists at this path.', { path });
      if (existOk || recursive) return publicStat(existing.node, normalized);
      throw new NumiOSError('ALREADY_EXISTS', 'Directory already exists.', { path });
    }
    if (recursive) {
      const parts = splitPath(normalized);
      let current = '';
      let result;
      for (const part of parts) {
        current += `/${part}`;
        const found = await this.#lookupOptional(current);
        if (found) {
          if (found.node.type !== 'directory') throw new NumiOSError('NOT_A_DIRECTORY', 'A path component is not a directory.', { path: current });
          result = publicStat(found.node, current);
        } else result = await this.#makeDirectory(current, { mode, owner, identity });
      }
      return result;
    }
    return this.#makeDirectory(normalized, { mode, owner, identity });
  }

  async #makeDirectory(path, { mode, owner, identity }) {
    const parentPath = dirname(path);
    const parent = await this.#lookup(parentPath);
    if (parent.node.type !== 'directory') throw new NumiOSError('NOT_A_DIRECTORY', 'The parent path is not a directory.', { parentPath });
    if (identity) assertMode(parent.node, identity, 'write');
    const name = basename(path);
    if (await this.#getEntry(parent.node.id, name)) throw new NumiOSError('ALREADY_EXISTS', 'A filesystem entry already exists at this path.', { path });
    const id = createId('ino');
    const now = this.#now();
    const node = { id, type: 'directory', name, parent: parent.node.id, owner, mode: parseMode(mode), createdAt: now, modifiedAt: now, size: 0 };
    await this.store.batch([
      { type: 'set', key: this.#inodeKey(id), value: node },
      { type: 'set', key: this.#entryKey(parent.node.id, name), value: id }
    ]);
    return publicStat(node, path);
  }

  async unlink(path, { recursive = false, identity = null } = {}) {
    await this.#assertWritable();
    const normalized = normalizePath(path);
    if (normalized === '/') throw new NumiOSError('PERMISSION_DENIED', 'The filesystem root cannot be removed.');
    const { node } = await this.#lookup(normalized, { followFinal: false });
    const parent = await this.#getNode(node.parent);
    if (identity) {
      assertMode(parent, identity, 'write');
      assertMode(node, identity, 'write');
    }
    if (node.type === 'directory') {
      const children = await this.store.list(this.#entryPrefix(node.id));
      if (children.length && !recursive) throw new NumiOSError('DIRECTORY_NOT_EMPTY', 'Directory is not empty.', { path });
      if (recursive) {
        for (const [, childId] of children) {
          const child = await this.#getNode(childId);
          await this.unlink(`${normalized}/${child.name}`, { recursive: true, identity });
        }
      }
    }
    const operations = [
      { type: 'delete', key: this.#entryKey(node.parent, node.name) },
      { type: 'delete', key: this.#inodeKey(node.id) }
    ];
    if (node.type === 'file') operations.push({ type: 'delete', key: this.#contentKey(node.id) });
    await this.store.batch(operations);
    return { removed: normalized, inode: node.id };
  }

  async rename(from, to, { identity = null } = {}) {
    await this.#assertWritable();
    const sourcePath = normalizePath(from);
    const targetPath = normalizePath(to);
    if (sourcePath === '/' || targetPath === '/') throw new NumiOSError('PERMISSION_DENIED', 'The filesystem root cannot be renamed or overwritten.');
    const { node: source } = await this.#lookup(sourcePath, { followFinal: false });
    if (source.type === 'directory' && targetPath.startsWith(`${sourcePath}/`)) throw new NumiOSError('INVALID_ARGUMENT', 'A directory cannot be moved into itself.');
    const targetParentPath = dirname(targetPath);
    const targetParent = await this.#lookup(targetParentPath);
    if (targetParent.node.type !== 'directory') throw new NumiOSError('NOT_A_DIRECTORY', 'Destination parent is not a directory.', { targetParentPath });
    if (await this.#getEntry(targetParent.node.id, basename(targetPath))) throw new NumiOSError('ALREADY_EXISTS', 'Destination already exists.', { targetPath });
    const oldParent = await this.#getNode(source.parent);
    if (identity) {
      assertMode(oldParent, identity, 'write');
      assertMode(targetParent.node, identity, 'write');
    }
    const moved = { ...source, parent: targetParent.node.id, name: basename(targetPath), modifiedAt: this.#now() };
    await this.store.batch([
      { type: 'delete', key: this.#entryKey(source.parent, source.name) },
      { type: 'set', key: this.#entryKey(targetParent.node.id, moved.name), value: source.id },
      { type: 'set', key: this.#inodeKey(source.id), value: moved }
    ]);
    return publicStat(moved, targetPath);
  }

  async copy(from, to, { identity = null } = {}) {
    await this.#assertWritable();
    const sourcePath = normalizePath(from);
    const targetPath = normalizePath(to);
    const source = await this.#lookup(sourcePath);
    if (await this.#lookupOptional(targetPath)) throw new NumiOSError('ALREADY_EXISTS', 'Copy destination already exists.', { targetPath });
    const parent = await this.#lookup(dirname(targetPath));
    if (parent.node.type !== 'directory') throw new NumiOSError('NOT_A_DIRECTORY', 'Copy destination parent is not a directory.');
    if (identity) assertMode(parent.node, identity, 'write');
    const stagingPath = `${dirname(targetPath) === '/' ? '' : dirname(targetPath)}/.numios-copy-${createId('tx')}`;
    try {
      await this.#copyTree(source.node, sourcePath, stagingPath, identity);
      await this.rename(stagingPath, targetPath, { identity });
      return this.stat(targetPath);
    } catch (error) {
      await this.unlink(stagingPath, { recursive: true }).catch(() => {});
      throw error;
    }
  }

  async #copyTree(sourceNode, sourcePath, targetPath, identity) {
    if (sourceNode.type === 'file') {
      const data = await this.readFile(sourcePath, { identity });
      await this.writeFile(targetPath, data, { create: true, mode: sourceNode.mode, owner: sourceNode.owner, identity });
      return;
    }
    if (sourceNode.type !== 'directory') throw new NumiOSError('NOT_SUPPORTED', 'Symbolic links cannot be copied by this filesystem.');
    await this.mkdir(targetPath, { mode: sourceNode.mode, owner: sourceNode.owner, identity });
    for (const entry of await this.readdir(sourcePath)) {
      await this.#copyTree(await this.#lookup(`${sourcePath === '/' ? '' : sourcePath}/${entry.name}`, { followFinal: false }).then(result => result.node), `${sourcePath === '/' ? '' : sourcePath}/${entry.name}`, `${targetPath}/${entry.name}`, identity);
    }
  }

  async chmod(path, mode, { identity = null, owner = undefined } = {}) {
    await this.#assertWritable();
    const normalized = normalizePath(path);
    const { node } = await this.#lookup(normalized, { followFinal: false });
    if (identity && !identity.capabilities?.includes?.('*') && !identity.capabilities?.includes?.('system.admin') && identity.id !== node.owner && identity.uid !== node.owner) {
      throw new NumiOSError('FS_PERMISSION_DENIED', 'Only the owner or system can change this inode.');
    }
    node.mode = parseMode(mode);
    if (owner !== undefined) node.owner = String(owner);
    node.modifiedAt = this.#now();
    await this.store.set(this.#inodeKey(node.id), node);
    return publicStat(node, normalized);
  }

  async symlink(target, path, { owner = this.owner, mode = 0o777 } = {}) {
    await this.#assertWritable();
    if (typeof target !== 'string' || !target || target.includes('\u0000')) throw new NumiOSError('INVALID_ARGUMENT', 'Symbolic link target is invalid.');
    const linkPath = normalizePath(path);
    if (await this.#lookupOptional(linkPath)) throw new NumiOSError('ALREADY_EXISTS', 'Symbolic link path already exists.');
    const parent = await this.#lookup(dirname(linkPath));
    if (parent.node.type !== 'directory') throw new NumiOSError('NOT_A_DIRECTORY', 'Symbolic link parent is not a directory.');
    const id = createId('ino');
    const now = this.#now();
    const node = { id, type: 'symlink', name: basename(linkPath), parent: parent.node.id, owner, mode: parseMode(mode), createdAt: now, modifiedAt: now, size: target.length, target };
    await this.store.batch([
      { type: 'set', key: this.#inodeKey(id), value: node },
      { type: 'set', key: this.#entryKey(parent.node.id, node.name), value: id }
    ]);
    return publicStat(node, linkPath);
  }

  async readlink(path) {
    const { node } = await this.#lookup(path, { followFinal: false });
    if (node.type !== 'symlink') throw new NumiOSError('INVALID_ARGUMENT', 'Path is not a symbolic link.');
    return node.target;
  }

  async realpath(path) {
    const result = await this.#lookup(path);
    return result.path;
  }

  async access(path, { identity = null, mode = 'read' } = {}) {
    const { node } = await this.#lookup(path);
    if (identity) assertMode(node, identity, mode);
    return true;
  }

  async usageBytes() {
    await this.ready();
    const inodes = await this.store.list(`${this.prefix}inode/`);
    return inodes.reduce((total, [, node]) => total + (node?.type === 'file' ? Number(node.size || 0) : 0), 0);
  }

  async exists(path) { return Boolean(await this.#lookupOptional(path)); }

  async #lookupOptional(path, options) {
    try { return await this.#lookup(path, options); }
    catch (error) { if (error.code === 'NOT_FOUND') return null; throw error; }
  }

  async #lookup(path, { followFinal = true, hopCount = 0 } = {}) {
    const normalized = normalizePath(path);
    if (hopCount > 16) throw new NumiOSError('SYMLINK_LOOP', 'Symbolic link traversal limit exceeded.', { path: normalized });
    const parts = splitPath(normalized);
    let parentId = ROOT_ID;
    const walked = [];
    if (parts.length === 0) return { node: await this.#getNode(ROOT_ID), path: '/' };
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      const childId = await this.#getEntry(parentId, name);
      if (!childId) throw new NumiOSError('NOT_FOUND', 'Filesystem path does not exist.', { path: normalized, component: name });
      const node = await this.#getNode(childId);
      if (!node) throw new NumiOSError('FILESYSTEM_CORRUPT', 'Directory entry refers to a missing inode.', { id: childId });
      const isFinal = index === parts.length - 1;
      if (node.type === 'symlink' && (!isFinal || followFinal)) {
        const targetBase = node.target.startsWith('/') ? node.target : `${walked.length ? `/${walked.join('/')}` : ''}/${node.target}`;
        const remaining = parts.slice(index + 1).join('/');
        const expanded = normalizePath(remaining ? `${targetBase}/${remaining}` : targetBase);
        return this.#lookup(expanded, { followFinal, hopCount: hopCount + 1 });
      }
      if (!isFinal && node.type !== 'directory') throw new NumiOSError('NOT_A_DIRECTORY', 'A path component is not a directory.', { path: normalized, component: name });
      if (isFinal) return { node, path: `/${[...walked, name].join('/')}` };
      walked.push(name);
      parentId = node.id;
    }
    throw new NumiOSError('NOT_FOUND', 'Filesystem path does not exist.', { path: normalized });
  }

  async #getNode(id) { return this.store.get(this.#inodeKey(id)); }
  async #getEntry(parentId, name) { return this.store.get(this.#entryKey(parentId, name)); }
  #inodeKey(id) { return `${this.prefix}inode/${id}`; }
  #contentKey(id) { return `${this.prefix}content/${id}`; }
  #entryPrefix(parentId) { return `${this.prefix}entry/${parentId}/`; }
  #entryKey(parentId, name) { return `${this.#entryPrefix(parentId)}${encodeURIComponent(name)}`; }
  #now() { return new Date(this.clock()).toISOString(); }

  #assertCapacity(current, next) {
    if (Number.isFinite(this.maxBytes) && next > this.maxBytes) throw new NumiOSError('STORAGE_QUOTA_EXCEEDED', 'The filesystem logical quota would be exceeded.', { currentBytes: current, nextBytes: next, limit: this.maxBytes });
  }

  async #assertWritable() {
    await this.ready();
    if (this.readOnly) throw new NumiOSError('READ_ONLY_FILESYSTEM', 'This filesystem is mounted read-only.');
  }
}

export class MemoryFileSystem extends TreeFileSystem {
  constructor(options = {}) {
    super({ ...options, name: options.name || 'memory', prefix: options.prefix || 'mem/' });
  }
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input === 'string') return new TextEncoder().encode(input);
  throw new NumiOSError('INVALID_ARGUMENT', 'File contents must be text, a byte array, or an ArrayBuffer.');
}

function publicStat(node, path) {
  return {
    id: node.id, type: node.type, name: node.name, path,
    owner: node.owner, mode: node.mode, size: Number(node.size || 0),
    createdAt: node.createdAt, modifiedAt: node.modifiedAt,
    ...(node.type === 'symlink' ? { target: node.target } : {})
  };
}

assertFilesystemContract(TreeFileSystem.prototype);
