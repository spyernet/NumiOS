import { KeyValueStore, validateBatch } from './store.js';
import { NumiOSError } from '../core/errors.js';

export class IndexedDBStore extends KeyValueStore {
  constructor({ indexedDB = globalThis.indexedDB, databaseName = 'numios', version = 1, storeName = 'records' } = {}) {
    super();
    if (!indexedDB) throw new NumiOSError('STORAGE_UNAVAILABLE', 'IndexedDB is not available in this browser context.');
    this.indexedDB = indexedDB;
    this.databaseName = databaseName;
    this.version = version;
    this.storeName = storeName;
    this.databasePromise = null;
    this.volatile = false;
  }

  async ready() {
    if (!this.databasePromise) this.databasePromise = this.#open();
    await this.databasePromise;
    return this;
  }

  #open() {
    return new Promise((resolve, reject) => {
      let request;
      try { request = this.indexedDB.open(this.databaseName, this.version); }
      catch (error) { reject(new NumiOSError('STORAGE_OPEN_FAILED', 'Could not open the NumiOS IndexedDB database.', { cause: error.message })); return; }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName, { keyPath: 'key' });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(new NumiOSError('STORAGE_OPEN_FAILED', 'Could not open the NumiOS IndexedDB database.', { cause: request.error?.message }));
      request.onblocked = () => reject(new NumiOSError('STORAGE_BLOCKED', 'The NumiOS database upgrade is blocked by another browser tab. Close older NumiOS tabs and retry.'));
    });
  }

  async get(key) {
    const db = await this.#db();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readonly');
      const request = transaction.objectStore(this.storeName).get(key);
      request.onsuccess = () => resolve(request.result?.value);
      request.onerror = () => reject(storageError('STORAGE_READ_FAILED', request.error));
      transaction.onabort = () => reject(storageError('STORAGE_READ_FAILED', transaction.error));
    });
  }

  async set(key, value) { return this.batch([{ type: 'set', key, value }]); }
  async delete(key) { return this.batch([{ type: 'delete', key }]); }

  async list(prefix = '') {
    const db = await this.#db();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readonly');
      const objectStore = transaction.objectStore(this.storeName);
      const range = prefix ? IDBKeyRange.bound(prefix, `${prefix}\uffff`, false, false) : undefined;
      const request = objectStore.openCursor(range);
      const entries = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (String(cursor.key).startsWith(prefix)) entries.push([cursor.key, cursor.value.value]);
        cursor.continue();
      };
      transaction.oncomplete = () => resolve(entries);
      transaction.onerror = () => reject(storageError('STORAGE_READ_FAILED', transaction.error));
      transaction.onabort = () => reject(storageError('STORAGE_READ_FAILED', transaction.error));
    });
  }

  async batch(operations) {
    validateBatch(operations);
    const db = await this.#db();
    return new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = db.transaction(this.storeName, 'readwrite', { durability: 'strict' });
      } catch {
        transaction = db.transaction(this.storeName, 'readwrite');
      }
      const objectStore = transaction.objectStore(this.storeName);
      try {
        for (const operation of operations) {
          if (operation.type === 'delete') objectStore.delete(operation.key);
          else objectStore.put({ key: operation.key, value: operation.value });
        }
      } catch (error) {
        transaction.abort();
        reject(storageError('STORAGE_WRITE_FAILED', error));
        return;
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(storageError('STORAGE_WRITE_FAILED', transaction.error));
      transaction.onabort = () => reject(storageError('STORAGE_WRITE_FAILED', transaction.error));
    });
  }

  async estimate() {
    try {
      const estimate = await globalThis.navigator?.storage?.estimate?.();
      return { usage: estimate?.usage ?? null, quota: estimate?.quota ?? null, available: Boolean(estimate) };
    } catch (error) {
      return { usage: null, quota: null, available: false, error: error.message };
    }
  }

  async requestDurability() {
    try {
      return Boolean(await globalThis.navigator?.storage?.persist?.());
    } catch {
      return false;
    }
  }

  async close() {
    if (!this.databasePromise) return;
    const db = await this.databasePromise.catch(() => null);
    db?.close();
    this.databasePromise = null;
  }

  async #db() {
    if (!this.databasePromise) await this.ready();
    return this.databasePromise;
  }
}

function storageError(code, error) {
  const name = error?.name;
  if (name === 'QuotaExceededError') return new NumiOSError('STORAGE_QUOTA_EXCEEDED', 'Browser storage quota was exceeded.', { cause: error.message });
  if (name === 'NotAllowedError' || name === 'SecurityError') return new NumiOSError('STORAGE_PERMISSION_DENIED', 'Browser storage access was denied.', { cause: error.message });
  return new NumiOSError(code, error?.message || 'IndexedDB operation failed.');
}
