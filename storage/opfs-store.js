import { KeyValueStore, validateBatch } from './store.js';
import { NumiOSError } from '../core/errors.js';

const JOURNAL_FILE = '__numios_transaction_journal__.json';

/** OPFS key/value adapter. It uses a recovery journal because separate OPFS files are not one atomic transaction. */
export class OPFSStore extends KeyValueStore {
  constructor({ storage = globalThis.navigator?.storage } = {}) {
    super();
    this.storage = storage;
    this.directoryPromise = null;
    this.operationQueue = Promise.resolve();
    this.volatile = false;
  }

  async ready() {
    if (!this.storage?.getDirectory) throw new NumiOSError('OPFS_UNAVAILABLE', 'Origin Private File System is not supported.');
    if (!this.directoryPromise) this.directoryPromise = this.storage.getDirectory();
    try {
      const directory = await this.directoryPromise;
      await this.#recover(directory);
      return this;
    } catch (error) {
      this.directoryPromise = null;
      if (error instanceof NumiOSError) throw error;
      throw new NumiOSError('OPFS_OPEN_FAILED', 'Could not initialize the OPFS store.', { cause: error.message });
    }
  }

  async get(key) {
    const directory = await this.#directory();
    try {
      const handle = await directory.getFileHandle(encodeKey(key));
      const file = await handle.getFile();
      return decodeValue(JSON.parse(await file.text()));
    } catch (error) {
      if (error.name === 'NotFoundError') return undefined;
      throw new NumiOSError('STORAGE_READ_FAILED', 'Could not read an OPFS record.', { cause: error.message });
    }
  }

  async set(key, value) { return this.batch([{ type: 'set', key, value }]); }
  async delete(key) { return this.batch([{ type: 'delete', key }]); }

  async list(prefix = '') {
    const directory = await this.#directory();
    const entries = [];
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind !== 'file' || name === JOURNAL_FILE) continue;
      const key = decodeKey(name);
      if (key === null || !key.startsWith(prefix)) continue;
      const file = await handle.getFile();
      entries.push([key, decodeValue(JSON.parse(await file.text()))]);
    }
    entries.sort(([a], [b]) => a.localeCompare(b));
    return entries;
  }

  async batch(operations) {
    validateBatch(operations);
    const previous = this.operationQueue;
    let release;
    this.operationQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const directory = await this.#directory();
      const changes = [];
      for (const operation of operations) changes.push({ key: operation.key, oldValue: await this.get(operation.key) });
      await writeFile(directory, JOURNAL_FILE, JSON.stringify(encodeValue(changes)));
      for (const operation of operations) {
        if (operation.type === 'delete') await removeFile(directory, encodeKey(operation.key));
        else await writeFile(directory, encodeKey(operation.key), JSON.stringify(encodeValue(operation.value)));
      }
      await removeFile(directory, JOURNAL_FILE);
    } catch (error) {
      const directory = await this.#directory().catch(() => null);
      if (directory) await this.#recover(directory).catch(recoveryError => {
        throw new NumiOSError('STORAGE_RECOVERY_FAILED', 'The OPFS transaction failed and its journal could not be recovered.', { cause: recoveryError.message, original: error.message });
      });
      throw error instanceof NumiOSError ? error : new NumiOSError('STORAGE_WRITE_FAILED', 'Could not commit OPFS transaction.', { cause: error.message });
    } finally {
      release();
    }
  }

  async estimate() {
    try {
      const estimate = await this.storage?.estimate?.();
      return { usage: estimate?.usage ?? null, quota: estimate?.quota ?? null, available: Boolean(estimate) };
    } catch (error) {
      return { usage: null, quota: null, available: false, error: error.message };
    }
  }

  async #directory() {
    if (!this.directoryPromise) await this.ready();
    return this.directoryPromise;
  }

  async #recover(directory) {
    let text;
    try { text = await (await (await directory.getFileHandle(JOURNAL_FILE)).getFile()).text(); }
    catch (error) { if (error.name === 'NotFoundError') return; throw error; }
    const changes = decodeValue(JSON.parse(text));
    if (!Array.isArray(changes)) throw new NumiOSError('STORAGE_JOURNAL_INVALID', 'The OPFS recovery journal is malformed.');
    for (const change of changes) {
      if (change.oldValue === undefined) await removeFile(directory, encodeKey(change.key));
      else await writeFile(directory, encodeKey(change.key), JSON.stringify(encodeValue(change.oldValue)));
    }
    await removeFile(directory, JOURNAL_FILE);
  }
}

async function writeFile(directory, name, text) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  await writable.write(text);
  await writable.close();
}

async function removeFile(directory, name) {
  try { await directory.removeEntry(name); }
  catch (error) { if (error.name !== 'NotFoundError') throw error; }
}

function encodeKey(key) {
  const bytes = new TextEncoder().encode(key);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `k-${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`;
}

function decodeKey(name) {
  if (!name.startsWith('k-')) return null;
  try {
    const normalized = name.slice(2).replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
  } catch { return null; }
}

function encodeValue(value) {
  if (value instanceof Uint8Array) return { __numiosType: 'Uint8Array', base64: toBase64(value) };
  if (value instanceof ArrayBuffer) return { __numiosType: 'ArrayBuffer', base64: toBase64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) return { __numiosType: 'Uint8Array', base64: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encodeValue(child)]));
  return value;
}

function decodeValue(value) {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value && typeof value === 'object') {
    if (value.__numiosType === 'Uint8Array') return fromBase64(value.base64);
    if (value.__numiosType === 'ArrayBuffer') return fromBase64(value.base64).buffer;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decodeValue(child)]));
  }
  return value;
}

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(base64) {
  const binary = atob(base64);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
