import { NumiOSError } from '../core/errors.js';
import { normalizePath } from '../fs/path.js';

export class WorkerRuntime {
  constructor({ syscallHost, processManager, logger = null, startupTimeoutMs = 15000, serviceStopTimeoutMs = 5000 } = {}) {
    this.syscallHost = syscallHost;
    this.processManager = processManager;
    this.logger = logger;
    this.startupTimeoutMs = startupTimeoutMs;
    this.serviceStopTimeoutMs = serviceStopTimeoutMs;
  }

  async launchApplication({ pid, packageRecord, args = [], env = {} } = {}) {
    await this.#assertAvailable();
    const workerUrl = new URL('./app-worker.js', import.meta.url);
    const entryUrl = this.#packageModuleUrl(packageRecord.id, packageRecord.version, packageRecord.entry);
    return this.#launch({
      pid, workerUrl, workerName: `NumiOS app ${packageRecord.id}`,
      initMessage: { type: 'numios:init', pid, applicationId: packageRecord.id, name: packageRecord.name, entryUrl, args, env }
    });
  }

  async startService({ definition, pid, onFailure = null } = {}) {
    await this.#assertAvailable();
    const entry = normalizePath(definition.service.entry);
    const workerUrl = new URL('./service-worker.js', import.meta.url);
    const entryUrl = this.#systemModuleUrl(entry);
    const result = await this.#launch({
      pid, workerUrl, workerName: `NumiOS service ${definition.unit.name}`,
      initMessage: { type: 'numios:init-service', pid, serviceName: definition.unit.name, entryUrl, config: definition.service.config || {} },
      expectedReadyType: 'numios:service-ready', failureType: 'numios:service-failure',
      onFailure
    });
    return {
      worker: result.worker,
      stop: async ({ reason = 'requested' } = {}) => {
        const stopped = waitForWorkerMessage(result.worker, 'numios:service-stopped', this.serviceStopTimeoutMs);
        result.worker.postMessage({ type: 'numios:stop-service', reason });
        try { await stopped; } finally { result.worker.terminate(); }
      }
    };
  }

  async #launch({ pid, workerUrl, workerName, initMessage, expectedReadyType = 'numios:started', failureType = 'numios:failure', onFailure = null }) {
    if (typeof MessageChannel !== 'function') throw new NumiOSError('API_UNAVAILABLE', 'MessageChannel is unavailable for worker syscalls.');
    let worker;
    try { worker = new Worker(workerUrl, { type: 'module', name: workerName }); }
    catch (error) { throw new NumiOSError('WORKER_START_FAILED', 'Could not create a dedicated module Worker.', { cause: error.message }); }
    const channel = new MessageChannel();
    const principalId = `pid:${pid}`;
    const detach = this.syscallHost.attach(channel.port1, principalId);
    this.processManager.attachWorker(pid, worker, { cleanup: detach });
    const startup = deferred();
    let started = false;
    let ended = false;
    const startupTimer = setTimeout(() => {
      if (!started) startup.reject(new NumiOSError('WORKER_START_TIMEOUT', 'Worker did not complete its startup handshake.'));
    }, this.startupTimeoutMs);
    worker.addEventListener('message', event => {
      const message = event.data;
      if (message?.type === expectedReadyType && message.pid === pid) {
        started = true;
        clearTimeout(startupTimer);
        startup.resolve({ worker, pid, startedAt: new Date().toISOString() });
      } else if (message?.type === failureType) {
        const error = new NumiOSError(message.error?.code || 'WORKER_RUNTIME_ERROR', message.error?.message || 'Worker reported a runtime failure.');
        if (!started) { clearTimeout(startupTimer); startup.reject(error); }
        else if (!ended) {
          ended = true;
          void (onFailure ? onFailure(error) : this.processManager.exit(pid, { failed: true, exitCode: 1, error }));
        }
      } else if (message?.type === 'numios:exit' && message.pid === pid) {
        ended = true;
        void this.processManager.exit(pid, { exitCode: Number.isInteger(message.exitCode) ? message.exitCode : 0 });
      }
    });
    worker.addEventListener('error', event => {
      event.preventDefault?.();
      const error = new NumiOSError('WORKER_CRASH', event.message || 'Worker crashed.');
      if (!started) { clearTimeout(startupTimer); startup.reject(error); }
      if (!ended) {
        ended = true;
        void (onFailure ? onFailure(error) : this.processManager.exit(pid, { failed: true, exitCode: 1, error }));
      }
    });
    worker.addEventListener('messageerror', () => {
      const error = new NumiOSError('WORKER_MESSAGE_ERROR', 'Worker sent a non-cloneable message.');
      if (!started) { clearTimeout(startupTimer); startup.reject(error); }
      if (!ended) {
        ended = true;
        void (onFailure ? onFailure(error) : this.processManager.exit(pid, { failed: true, exitCode: 1, error }));
      }
    });
    try {
      worker.postMessage({ ...initMessage, syscallPort: channel.port2 }, [channel.port2]);
      const startedResult = await startup.promise;
      await this.logger?.info('runtime', 'Worker process started.', { eventCode: 'WORKER_STARTED', pid, workerName }, principalId);
      return startedResult;
    } catch (error) {
      clearTimeout(startupTimer);
      worker.terminate();
      detach();
      throw error;
    }
  }

  async #assertAvailable() {
    if (typeof Worker !== 'function') throw new NumiOSError('API_UNAVAILABLE', 'Web Workers are not available in this browser.');
    if (!globalThis.location || !['https:', 'http:'].includes(location.protocol) || (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1')) {
      throw new NumiOSError('SECURE_ORIGIN_REQUIRED', 'Workers and the NumiOS service-worker module route require HTTPS or localhost.');
    }
    const serviceWorker = globalThis.navigator?.serviceWorker;
    if (!serviceWorker) throw new NumiOSError('SERVICE_WORKER_UNAVAILABLE', 'Service workers are unavailable; virtual NPP modules cannot be loaded.');
    if (!serviceWorker.controller) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new NumiOSError('SERVICE_WORKER_NOT_CONTROLLING', 'The service worker has not taken control of this page. Reload after the first service-worker installation.')); }, this.startupTimeoutMs);
        const onChange = () => { if (serviceWorker.controller) { cleanup(); resolve(); } };
        const cleanup = () => { clearTimeout(timer); serviceWorker.removeEventListener('controllerchange', onChange); };
        serviceWorker.addEventListener('controllerchange', onChange);
        onChange();
      });
    }
  }

  #packageModuleUrl(id, version, entry) {
    const path = String(entry).split('/').map(segment => encodeURIComponent(segment)).join('/');
    return new URL(`/__numios__/apps/${encodeURIComponent(id)}/${encodeURIComponent(version)}/${path}`, location.origin).href;
  }

  #systemModuleUrl(path) {
    const normalized = normalizePath(path);
    const encoded = normalized.split('/').filter(Boolean).map(segment => encodeURIComponent(segment)).join('/');
    return new URL(`/__numios__/system/${encoded}`, location.origin).href;
  }
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function waitForWorkerMessage(worker, type, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new NumiOSError('WORKER_STOP_TIMEOUT', 'Worker did not stop within the configured timeout.')); }, timeoutMs);
    const listener = event => { if (event.data?.type === type) { cleanup(); resolve(event.data); } };
    const cleanup = () => { clearTimeout(timer); worker.removeEventListener('message', listener); };
    worker.addEventListener('message', listener);
  });
}
