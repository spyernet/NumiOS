export class LifecycleManager {
  constructor({ store, logger = null, target = globalThis.window, clock = () => Date.now() } = {}) {
    this.store = store;
    this.logger = logger;
    this.target = target;
    this.clock = clock;
    this.started = false;
    this.listeners = [];
  }

  start() {
    if (this.started || !this.target?.addEventListener) return this;
    this.started = true;
    const onVisibility = () => {
      if (this.target.document?.visibilityState === 'hidden') void this.#checkpoint('hidden');
      else void this.#checkpoint('visible');
    };
    const onFreeze = () => { void this.#checkpoint('frozen'); };
    const onPageHide = () => { void this.#checkpoint('interrupted'); };
    this.target.document?.addEventListener('visibilitychange', onVisibility);
    this.target.addEventListener('freeze', onFreeze);
    this.target.addEventListener('pagehide', onPageHide);
    this.listeners.push(() => this.target.document?.removeEventListener('visibilitychange', onVisibility));
    this.listeners.push(() => this.target.removeEventListener('freeze', onFreeze));
    this.listeners.push(() => this.target.removeEventListener('pagehide', onPageHide));
    return this;
  }

  async #checkpoint(state) {
    try {
      await this.store?.set?.('lifecycle/page-state', { state, timestamp: new Date(this.clock()).toISOString() });
      if (state === 'interrupted') await this.store?.set?.('lifecycle/boot-state', { state: 'interrupted', timestamp: new Date(this.clock()).toISOString() });
      if (state === 'hidden' || state === 'frozen' || state === 'interrupted') await this.logger?.flush?.();
    } catch (error) {
      await this.logger?.warn?.('lifecycle', 'Lifecycle checkpoint failed.', { eventCode: 'LIFECYCLE_CHECKPOINT_FAILED', state, error: error.message });
    }
  }

  stop() {
    for (const remove of this.listeners.splice(0)) remove();
    this.started = false;
  }
}
