import { NumiOSError } from '../core/errors.js';

export class KeyValueStore {
  async ready() { throw new NumiOSError('NOT_IMPLEMENTED', 'Store.ready must be implemented.'); }
  async get(_key) { throw new NumiOSError('NOT_IMPLEMENTED', 'Store.get must be implemented.'); }
  async set(_key, _value) { throw new NumiOSError('NOT_IMPLEMENTED', 'Store.set must be implemented.'); }
  async delete(_key) { throw new NumiOSError('NOT_IMPLEMENTED', 'Store.delete must be implemented.'); }
  async list(_prefix = '') { throw new NumiOSError('NOT_IMPLEMENTED', 'Store.list must be implemented.'); }
  async batch(_operations) { throw new NumiOSError('NOT_IMPLEMENTED', 'Store.batch must be implemented.'); }
  async estimate() { return { usage: null, quota: null, available: false }; }
  async close() {}

  async deletePrefix(prefix) {
    const entries = await this.list(prefix);
    if (entries.length) await this.batch(entries.map(([key]) => ({ type: 'delete', key })));
    return entries.length;
  }
}

export function validateKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1024 || key.includes('\u0000')) {
    throw new NumiOSError('INVALID_ARGUMENT', 'Storage keys must be non-empty strings no longer than 1024 characters.');
  }
}

export function validateBatch(operations) {
  if (!Array.isArray(operations) || operations.length > 10000) throw new NumiOSError('INVALID_ARGUMENT', 'A storage batch must be an array of at most 10000 operations.');
  for (const operation of operations) {
    if (!operation || !['set', 'delete'].includes(operation.type)) throw new NumiOSError('INVALID_ARGUMENT', 'Unknown storage operation.');
    validateKey(operation.key);
    if (operation.type === 'set' && !Object.hasOwn(operation, 'value')) throw new NumiOSError('INVALID_ARGUMENT', 'Set operation requires a value.');
  }
}

export function isValidStoreValue(value) {
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return true;
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol' || value === undefined) return false;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof Blob || value instanceof Date) return true;
  if (Array.isArray(value)) return value.every(isValidStoreValue);
  if (typeof value === 'object') return Object.values(value).every(isValidStoreValue);
  return false;
}
