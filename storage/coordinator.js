import { NumiOSError } from '../core/errors.js';

/** Cross-context coordination uses Web Locks when available; the fallback is only per-realm serialization. */
export class CrossContextCoordinator {
  constructor({ locks = globalThis.navigator?.locks, channelName = 'numios-events' } = {}) {
    this.locks = locks;
    this.channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(channelName) : null;
    this.localQueues = new Map();
    this.events = new Set();
    if (this.channel) this.channel.onmessage = event => {
      for (const listener of this.events) listener(event.data);
    };
  }

  async withLock(name, callback, { signal, mode = 'exclusive' } = {}) {
    if (typeof callback !== 'function') throw new NumiOSError('INVALID_ARGUMENT', 'Lock callback must be a function.');
    if (this.locks?.request) return this.locks.request(`numios:${name}`, { mode, signal }, callback);
    const previous = this.localQueues.get(name) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => current);
    this.localQueues.set(name, queued);
    try {
      await waitForTurn(previous, signal);
      if (signal?.aborted) throw abortReason(signal);
      return await callback();
    } finally {
      release();
      if (this.localQueues.get(name) === queued) this.localQueues.delete(name);
    }
  }

  publish(message) {
    this.channel?.postMessage(message);
  }

  subscribe(listener) {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }

  close() {
    this.channel?.close();
    this.events.clear();
    this.channel = null;
  }
}

function waitForTurn(previous, signal) {
  if (!signal) return previous;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    previous.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function abortReason(signal) {
  return signal.reason || new DOMException('The operation was aborted.', 'AbortError');
}
