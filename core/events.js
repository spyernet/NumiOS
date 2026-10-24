import { NumiOSError } from './errors.js';

export class EventHub {
  #listeners = new Map();

  on(type, listener, options = {}) {
    if (typeof listener !== 'function') throw new NumiOSError('INVALID_ARGUMENT', 'Event listener must be a function.');
    const entry = { listener, once: Boolean(options.once) };
    const listeners = this.#listeners.get(type) || new Set();
    listeners.add(entry);
    this.#listeners.set(type, listeners);
    return () => this.off(type, listener);
  }

  once(type, listener) {
    return this.on(type, listener, { once: true });
  }

  off(type, listener) {
    const listeners = this.#listeners.get(type);
    if (!listeners) return false;
    for (const entry of listeners) {
      if (entry.listener === listener) listeners.delete(entry);
    }
    if (listeners.size === 0) this.#listeners.delete(type);
    return true;
  }

  emit(type, detail) {
    const listeners = this.#listeners.get(type);
    if (!listeners) return;
    for (const entry of [...listeners]) {
      if (entry.once) listeners.delete(entry);
      try {
        entry.listener(detail);
      } catch (error) {
        queueMicrotask(() => { throw error; });
      }
    }
    if (listeners.size === 0) this.#listeners.delete(type);
  }

  waitFor(type, { signal, timeoutMs } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      let timer;
      const off = this.once(type, value => {
        cleanup();
        resolve(value);
      });
      const onAbort = () => {
        cleanup();
        reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      };
      const cleanup = () => {
        off();
        signal?.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          cleanup();
          reject(new NumiOSError('TIMEOUT', `Timed out waiting for event ${type}.`));
        }, Math.max(0, timeoutMs));
      }
    });
  }

  clear() {
    this.#listeners.clear();
  }
}
