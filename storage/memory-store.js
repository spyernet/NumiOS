import { KeyValueStore, validateBatch, isValidStoreValue } from './store.js';
import { NumiOSError } from '../core/errors.js';

/** Explicitly volatile test/development adapter. It must never be selected as the browser's persistent root automatically. */
export class MemoryStore extends KeyValueStore {
  constructor(seed = undefined) {
    super();
    this.records = new Map(seed || []);
    this.volatile = true;
  }

  async ready() { return this; }
  async get(key) { return clone(this.records.get(key)); }
  async set(key, value) { await this.batch([{ type: 'set', key, value }]); }
  async delete(key) { await this.batch([{ type: 'delete', key }]); }

  async list(prefix = '') {
    return [...this.records.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, clone(value)]);
  }

  async batch(operations) {
    validateBatch(operations);
    for (const operation of operations) {
      if (operation.type === 'set' && !isValidStoreValue(operation.value)) throw new NumiOSError('DATA_CLONE_ERROR', 'Value cannot be stored by the test adapter.');
    }
    const next = new Map(this.records);
    for (const operation of operations) {
      if (operation.type === 'delete') next.delete(operation.key);
      else next.set(operation.key, clone(operation.value));
    }
    this.records = next;
  }

  async estimate() {
    let usage = 0;
    for (const [key, value] of this.records) usage += key.length * 2 + estimateValue(value);
    return { usage, quota: null, available: true, volatile: true };
  }
}

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (value instanceof Uint8Array) return value.slice();
  return JSON.parse(JSON.stringify(value));
}

function estimateValue(value) {
  if (typeof value === 'string') return value.length * 2;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  try { return JSON.stringify(value).length * 2; } catch { return 0; }
}
