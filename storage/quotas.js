import { NumiOSError } from '../core/errors.js';

export class QuotaManager {
  constructor({ store, logicalLimits = {} } = {}) {
    this.store = store;
    this.logicalLimits = { rootBytes: 64 * 1024 * 1024, tempBytes: 16 * 1024 * 1024, ...logicalLimits };
  }

  async estimate() {
    const backend = await this.store?.estimate?.() || { available: false, usage: null, quota: null };
    return {
      backend: backend.volatile ? 'volatile' : 'browser-storage',
      usage: backend.usage,
      quota: backend.quota,
      available: backend.available,
      logicalLimits: { ...this.logicalLimits }
    };
  }

  assertLogicalCapacity(currentBytes, nextBytes, limit = this.logicalLimits.rootBytes) {
    if (Number.isFinite(limit) && nextBytes > limit) {
      throw new NumiOSError('STORAGE_QUOTA_EXCEEDED', 'The NumiOS filesystem quota would be exceeded.', { currentBytes, nextBytes, limit });
    }
  }

  async requestPersistence() {
    try { return Boolean(await globalThis.navigator?.storage?.persist?.()); }
    catch { return false; }
  }

  async checkHealth() {
    const estimate = await this.estimate();
    return { healthy: estimate.available && estimate.quota !== 0, ...estimate };
  }
}
