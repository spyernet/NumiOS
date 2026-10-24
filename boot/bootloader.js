import { BootManager } from './boot-manager.js';
import { DEFAULT_BOOT_CONFIG, DEFAULT_SYSTEM_CONFIG, DEFAULT_SECURITY_CONFIG } from './default-config.js';
import { Kernel } from '../kernel/kernel.js';
import { IndexedDBStore } from '../storage/indexeddb-store.js';
import { MemoryStore } from '../storage/memory-store.js';
import { CrossContextCoordinator } from '../storage/coordinator.js';
import { Logger } from '../core/logger.js';
import { NumiOSError } from '../core/errors.js';
import { LifecycleManager } from './lifecycle.js';

export class Bootloader {
  constructor({ fetchImpl = globalThis.fetch, events = undefined, storeFactory = null, onProgress = null } = {}) {
    this.fetchImpl = fetchImpl;
    this.events = events;
    this.storeFactory = storeFactory;
    this.onProgress = onProgress;
    this.resources = null;
    this.store = null;
    this.coordinator = null;
    this.logger = null;
    this.bootManager = null;
    this.warnings = [];
    this.control = null;
    this.serviceWorkerRegistration = null;
    this.lifecycle = null;
  }

  async start() {
    if (this.bootManager) return this.bootManager.boot();
    this.resources = await this.#loadResources();
    this.warnings.push(...this.resources.warnings);
    if (this.resources.systemConfig.storage?.backend === 'indexeddb') {
      try {
        this.store = this.storeFactory ? this.storeFactory(this.resources.systemConfig) : new IndexedDBStore({
          databaseName: this.resources.systemConfig.storage?.databaseName || 'numios',
          version: this.resources.systemConfig.storage?.databaseVersion || 1
        });
      } catch (error) {
        if (!this.resources.systemConfig.storage?.allowEphemeralRoot) throw error;
        this.store = new MemoryStore();
        this.resources.systemConfig.storage.backend = 'memory-volatile';
        this.warnings.push(`Persistent storage unavailable; explicit ephemeral fallback selected: ${error.message}`);
      }
    } else if (this.resources.systemConfig.storage?.allowEphemeralRoot) {
      this.store = new MemoryStore();
      this.resources.systemConfig.storage.backend = 'memory-volatile';
    } else {
      throw new NumiOSError('STORAGE_UNAVAILABLE', 'NumiOS requires IndexedDB for a persistent root; ephemeral storage was not explicitly enabled.');
    }
    if (!this.store.volatile) {
      try { await this.store.ready(); }
      catch (error) {
        if (!this.resources.systemConfig.storage?.allowEphemeralRoot) throw error;
        await this.store.close?.();
        this.store = new MemoryStore();
        this.resources.systemConfig.storage.backend = 'memory-volatile';
        this.warnings.push(`Persistent IndexedDB could not be opened; explicit ephemeral fallback selected: ${error.message}`);
      }
    }
    this.coordinator = new CrossContextCoordinator();
    this.logger = new Logger({ store: this.store, capacity: this.resources.systemConfig.logging?.capacity || 2000, level: this.resources.systemConfig.logging?.level || 'info', events: this.events });
    if (this.resources.bootConfig.registerServiceWorker) await this.#registerServiceWorker();

    this.bootManager = new BootManager({
      config: this.resources.bootConfig,
      configError: this.resources.configError,
      store: this.store,
      logger: this.logger,
      events: this.events,
      createKernel: ({ recoveryMode, bootConfig }) => new Kernel({
        store: this.store,
        systemConfig: this.resources.systemConfig,
        securityConfig: this.resources.securityConfig,
        repositoryConfig: this.resources.repositoryConfig,
        mountConfig: this.resources.mountConfig,
        bootConfig,
        syscallTable: this.resources.syscallTable,
        serviceDefinitions: this.resources.serviceDefinitions,
        serviceSchema: this.resources.serviceSchema,
        configSchemas: this.resources.configSchemas,
        coordinator: this.coordinator,
        logger: this.logger,
        recoveryMode
      })
    });
    this.bootManager.events.on('boot.progress', detail => this.onProgress?.(detail));
    const status = await this.bootManager.boot();
    this.control = this.#createControlApi();
    if (this.bootManager.kernel) this.lifecycle = new LifecycleManager({ store: this.store, logger: this.logger }).start();
    return status;
  }

  async reboot() {
    if (!this.bootManager) return this.start();
    this.lifecycle?.stop();
    this.coordinator = new CrossContextCoordinator();
    const status = await this.bootManager.reboot();
    if (this.bootManager.kernel) this.lifecycle = new LifecycleManager({ store: this.store, logger: this.logger }).start();
    return status;
  }

  async shutdown(options = {}) {
    this.lifecycle?.stop();
    return this.bootManager ? this.bootManager.shutdown(options) : { state: 'cold' };
  }
  status() { return this.bootManager?.status() || { state: 'cold', warnings: [...this.warnings] }; }
  api() { return this.control || this.#createControlApi(); }

  async #loadResources() {
    const warnings = [];
    let configError = null;
    const readJson = async (path, fallback, { critical = false } = {}) => {
      try { return await fetchJson(new URL(path, import.meta.url), this.fetchImpl); }
      catch (error) {
        const warning = `${path}: ${error.message}`;
        warnings.push(warning);
        if (critical) throw new NumiOSError('BOOT_ASSET_MISSING', `Required boot asset '${path}' could not be loaded.`, { cause: error.message });
        configError ||= new NumiOSError('BOOT_CONFIG_RECOVERED', `Configuration asset '${path}' was unavailable; a safe default will be used.`, { cause: error.message });
        return structuredCloneSafe(fallback);
      }
    };
    const bootConfig = await readJson('./boot-config.json', DEFAULT_BOOT_CONFIG);
    const systemConfig = await readJson('../etc/system.json', DEFAULT_SYSTEM_CONFIG);
    const securityConfig = await readJson('../etc/security.json', DEFAULT_SECURITY_CONFIG);
    const repositoryConfig = await readJson('../etc/repositories.json', { schemaVersion: 1, repositories: [] });
    const mountConfig = await readJson('../etc/mounts.json', { schemaVersion: 1, mounts: [] });
    const syscallTable = await readJson('../kernel/syscall/syscall-table.json', null, { critical: true });
    const serviceSchema = await readJson('../services/service.schema.json', null);
    const configSchemas = {
      system: await readJson('../etc/schemas/system.schema.json', null),
      security: await readJson('../etc/schemas/security.schema.json', null),
      repositories: await readJson('../etc/schemas/repositories.schema.json', null),
      mounts: await readJson('../etc/schemas/mounts.schema.json', null)
    };
    const serviceDefinitions = [];
    for (const path of bootConfig.serviceUnits || DEFAULT_BOOT_CONFIG.serviceUnits || []) {
      try { serviceDefinitions.push(await fetchJson(new URL(path, import.meta.url), this.fetchImpl)); }
      catch (error) {
        warnings.push(`${path}: ${error.message}`);
        configError ||= new NumiOSError('SERVICE_UNIT_ASSET_MISSING', 'A built-in service unit could not be loaded.', { path, cause: error.message });
      }
    }
    return { bootConfig, systemConfig, securityConfig, repositoryConfig, mountConfig, syscallTable, serviceSchema, configSchemas, serviceDefinitions, warnings, configError };
  }

  async #registerServiceWorker() {
    const serviceWorker = globalThis.navigator?.serviceWorker;
    if (!serviceWorker) {
      this.warnings.push('Service workers are unavailable; NPP worker applications and offline interception will be disabled.');
      return;
    }
    try {
      const script = new URL('../service-worker.js', import.meta.url);
      this.serviceWorkerRegistration = await serviceWorker.register(script, { scope: new URL('../', import.meta.url).pathname });
      const readiness = await settleWithin(serviceWorker.ready, 5000);
      if (readiness.error) throw readiness.error;
      if (!readiness.completed) this.warnings.push('Service worker activation did not finish before the startup wait expired.');
      if (!serviceWorker.controller) await waitForEventOrTimeout(serviceWorker, 'controllerchange', 1500);
      if (!serviceWorker.controller) this.warnings.push('Service worker registered but has not claimed this page yet; reload once before launching NPP applications.');
    } catch (error) {
      this.warnings.push(`Service worker registration failed: ${error.message}`);
    }
  }

  #createControlApi() {
    const manager = this.bootManager;
    const kernel = () => manager?.kernel;
    const call = (name, args = {}, options = {}) => {
      if (!kernel()?.dispatcher) return Promise.resolve({ ok: false, data: null, error: { code: 'KERNEL_NOT_READY', message: 'Kernel syscall dispatcher is unavailable.' }, requestId: null });
      return kernel().dispatcher.call(name, args, { ...options, callerId: 'system' });
    };
    const api = {
      boot: () => manager.boot(),
      reboot: () => this.reboot(),
      shutdown: options => this.shutdown(options),
      status: () => manager.status(),
      info: () => kernel()?.systemInfo() || null,
      sys: Object.freeze({ call, list: () => call('syscall.list', {}) }),
      processes: () => call('process.list', {}),
      mounts: () => call('disk.list', {}),
      services: Object.freeze({ list: () => call('service.list', {}), start: name => call('service.start', { name }), stop: name => call('service.stop', { name }), restart: name => call('service.restart', { name }) }),
      packages: Object.freeze({ list: options => call('package.list', options || {}), query: id => call('package.query', { id }), install: options => call('package.install', options), remove: (id, options = {}) => call('package.remove', { id, ...options }), update: id => call('package.update', id ? { id } : {}) }),
      repositories: Object.freeze({ list: () => call('repository.list', {}), query: (packageId, range = '*') => call('repository.query', { packageId, range }), refresh: id => call('repository.refresh', id ? { id } : {}), createLocal: (id, name = id) => call('repository.local.create', { id, name }), publishLocal: (repositoryId, archive) => call('repository.local.publish', { repositoryId, archive }), removeLocal: (repositoryId, packageId, version) => call('repository.local.remove', { repositoryId, packageId, version }) }),
      logs: options => call('log.query', options || {}),
      health: () => call('diagnostics.run', {}),
      config: Object.freeze({ get: name => call('config.get', { name }), list: () => call('config.list', {}), update: (name, value) => call('config.update', { name, value }), reload: name => call('config.reload', { name }) }),
      authorizeDirectory: options => {
        const picker = globalThis.showDirectoryPicker;
        if (typeof picker !== 'function') return Promise.resolve({ ok: false, data: null, error: { code: 'API_UNAVAILABLE', message: 'The File System Access API directory picker is not supported.' }, requestId: null });
        const settings = options && typeof options === 'object' ? options : {};
        let picked;
        try { picked = picker.call(globalThis, { mode: settings.readOnly ? 'read' : 'readwrite' }); }
        catch (error) { return Promise.resolve({ ok: false, data: null, error: { code: error.code || 'USER_PERMISSION_DENIED', message: error.message }, requestId: null }); }
        return Promise.resolve(picked).then(handle => {
          const args = { handle, readOnly: Boolean(settings.readOnly) };
          if (settings.id !== undefined) args.id = settings.id;
          if (settings.mountPoint !== undefined) args.mountPoint = settings.mountPoint;
          return call('disk.authorizeDirectory', args);
        }).catch(error => ({ ok: false, data: null, error: { code: error.code || (error.name === 'AbortError' ? 'CANCELLED' : 'USER_PERMISSION_DENIED'), message: error.message }, requestId: null }));
      },
      warnings: () => [...this.warnings],
      on: (event, listener) => manager.events.on(event, listener)
    };
    return Object.freeze(api);
  }
}

async function fetchJson(url, fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new NumiOSError('FETCH_UNAVAILABLE', 'Fetch API is unavailable.');
  let response;
  try { response = await fetchImpl(url, { headers: { accept: 'application/json' } }); }
  catch (error) { throw new NumiOSError('BOOT_FETCH_FAILED', 'Could not fetch a static boot resource. Use an HTTP(S) static origin.', { url: String(url), cause: error.message }); }
  if (!response.ok) throw new NumiOSError('BOOT_FETCH_FAILED', `Static resource returned HTTP ${response.status}.`, { url: String(url), status: response.status });
  try { return await response.json(); }
  catch (error) { throw new NumiOSError('BOOT_JSON_INVALID', 'Static JSON resource could not be parsed.', { url: String(url), cause: error.message }); }
}
function settleWithin(promise, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => { settled = true; resolve({ completed: false }); }, timeoutMs);
    Promise.resolve(promise).then(
      value => { if (!settled) { settled = true; clearTimeout(timer); resolve({ completed: true, value }); } },
      error => { if (!settled) { settled = true; clearTimeout(timer); resolve({ completed: true, error }); } }
    );
  });
}
function waitForEventOrTimeout(target, eventName, timeoutMs) {
  return new Promise(resolve => {
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(eventName, onEvent);
    };
    const onEvent = () => { cleanup(); resolve(true); };
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    target.addEventListener(eventName, onEvent, { once: true });
  });
}
function structuredCloneSafe(value) { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
