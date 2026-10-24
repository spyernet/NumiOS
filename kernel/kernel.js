import { EventHub } from '../core/events.js';
import { createId } from '../core/ids.js';
import { NumiOSError } from '../core/errors.js';
import { parseJson } from '../core/schema.js';
import { Logger } from '../core/logger.js';
import { ConfigManager } from '../core/config-manager.js';
import { IndexedDBStore } from '../storage/indexeddb-store.js';
import { MemoryStore } from '../storage/memory-store.js';
import { QuotaManager } from '../storage/quotas.js';
import { CrossContextCoordinator } from '../storage/coordinator.js';
import { DiskManager } from '../storage/disk-manager.js';
import { TreeFileSystem } from '../fs/tree-filesystem.js';
import { StaticFileSystem } from '../fs/filesystems/static-filesystem.js';
import { VirtualFileSystem, decodeFileData } from '../fs/vfs.js';
import { normalizePath } from '../fs/path.js';
import { SecurityManager } from './security/security-manager.js';
import { Scheduler } from './scheduler/scheduler.js';
import { ResourceManager } from './resources/resource-manager.js';
import { ProcessManager } from './process/process-manager.js';
import { IpcBus } from './ipc/ipc-bus.js';
import { NetworkClient } from './network-client.js';
import { SyscallRegistry } from './syscall/registry.js';
import { SyscallDispatcher, SyscallHost } from './syscall/dispatcher.js';
import { createServiceSDK } from '../sdk/service-sdk.js';
import { DeviceRegistry, DeviceFileSystem } from '../dev/device-registry.js';
import { ProcFilesystem } from '../proc/proc-filesystem.js';
import { RepositoryManager } from '../packages/repository.js';
import { PackageManager } from '../packages/package-manager.js';
import { ApplicationLoader } from '../runtime/application-loader.js';
import { WorkerRuntime } from '../runtime/worker-runtime.js';
import { ServiceManager } from '../services/service-manager.js';
import { createBuiltinServices } from '../services/builtins.js';
import { Diagnostics } from './diagnostics/diagnostics.js';

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const REQUIRED_ROOT_DIRECTORIES = [
  '/System', '/System/Services', '/System/Resources', '/usr', '/bin', '/lib', '/dev', '/proc', '/etc',
  '/Apps', '/Library', '/Users', '/Users/demo', '/Volumes', '/Temp', '/var', '/var/log', '/var/cache',
  '/var/cache/numios', '/var/cache/numios/packages', '/var/state', '/var/lib', '/var/lib/numios', '/var/lib/numios/packages'
];

export class Kernel {
  constructor({
    store = null, systemConfig, securityConfig, repositoryConfig, mountConfig, bootConfig,
    syscallTable, serviceDefinitions = [], serviceSchema = null, configSchemas = {}, coordinator = null, logger = null,
    recoveryMode = false, clock = () => Date.now()
  } = {}) {
    this.id = createId('kernel');
    this.clock = clock;
    this.startedAt = this.clock();
    this.state = 'created';
    this.ready = false;
    this.recoveryMode = recoveryMode;
    this.systemConfig = structuredCloneSafe(systemConfig || defaultSystemConfig());
    this.securityConfig = structuredCloneSafe(securityConfig || defaultSecurityConfig());
    this.repositoryConfig = structuredCloneSafe(repositoryConfig || { schemaVersion: 1, repositories: [] });
    this.mountConfig = structuredCloneSafe(mountConfig || { schemaVersion: 1, mounts: [] });
    this.bootConfig = structuredCloneSafe(bootConfig || {});
    this.syscallTable = syscallTable;
    this.serviceDefinitions = serviceDefinitions;
    this.serviceSchema = serviceSchema;
    this.configSchemas = configSchemas;
    this.store = store;
    this.events = new EventHub();
    this.logger = logger;
    this.coordinator = coordinator;
    this.initializedStages = new Set();
    this.bootInfo = null;
    this.activeTarget = null;
    this.shutdownReason = null;
    this.rebootHandler = null;
    this.mountErrorCount = 0;
    this.rootFilesystem = null;
    this.vfs = null;
    this.quotaManager = null;
    this.configManager = null;
    this.diskManager = null;
    this.tempFilesystem = null;
    this.configuredMounts = new Map();
    this.security = null;
    this.scheduler = null;
    this.resources = null;
    this.processManager = null;
    this.ipc = null;
    this.networkClient = null;
    this.deviceRegistry = null;
    this.deviceFilesystem = null;
    this.procFilesystem = null;
    this.registry = null;
    this.dispatcher = null;
    this.syscallHost = null;
    this.repositoryManager = null;
    this.packageManager = null;
    this.applicationLoader = null;
    this.workerRuntime = null;
    this.serviceManager = null;
    this.diagnostics = null;
    if (!this.store) this.store = new IndexedDBStore({ databaseName: this.systemConfig.storage?.databaseName || 'numios', version: this.systemConfig.storage?.databaseVersion || 1 });
    if (!this.coordinator) this.coordinator = new CrossContextCoordinator();
    if (!this.logger) this.logger = new Logger({ store: this.store, capacity: this.systemConfig.logging?.capacity || 2000, level: this.systemConfig.logging?.level || 'info', events: this.events });
  }

  async initializeStorage() {
    this.#once('storage');
    this.state = 'starting';
    await this.store.ready();
    await this.logger.initialize();
    this.configManager = new ConfigManager({ store: this.store, events: this.events, logger: this.logger });
    this.systemConfig = await this.configManager.load('system', this.systemConfig, { currentVersion: 1, schema: this.configSchemas.system || { os: 'object', storage: 'object', runtime: 'object', logging: 'object', packages: 'object', applications: 'object' } });
    this.securityConfig = await this.configManager.load('security', this.securityConfig, { currentVersion: 1, schema: this.configSchemas.security || { applicationCapabilityAllowlist: 'object', denyLaunchWithUnapprovedCapabilities: 'boolean', trustedRepositories: 'object', protectedPaths: 'object' } });
    this.repositoryConfig = await this.configManager.load('repositories', this.repositoryConfig, { currentVersion: 1, schema: this.configSchemas.repositories || { repositories: 'object' } });
    this.mountConfig = await this.configManager.load('mounts', this.mountConfig, { currentVersion: 1, schema: this.configSchemas.mounts || { mounts: 'object' } });
    if (this.systemConfig.logging?.level) this.logger.level = this.systemConfig.logging.level;
    this.quotaManager = new QuotaManager({ store: this.store, logicalLimits: { rootBytes: this.systemConfig.storage?.rootQuotaBytes, tempBytes: this.systemConfig.storage?.tempQuotaBytes } });
    const previousBoot = await this.store.get('lifecycle/boot-state');
    this.interruptedPreviousBoot = previousBoot?.state === 'booting' || previousBoot?.state === 'interrupted';
    await this.store.set('lifecycle/boot-state', { state: 'booting', kernelId: this.id, startedAt: new Date(this.clock()).toISOString(), previous: previousBoot?.state || 'unknown' });
    if (this.systemConfig.storage?.requestPersistentStorage) await this.quotaManager.requestPersistence();

    this.rootFilesystem = new TreeFileSystem({
      store: this.store, prefix: 'fs/root/', name: 'numios-root',
      maxBytes: this.systemConfig.storage?.rootQuotaBytes ?? 64 * 1024 * 1024, owner: 'system', clock: this.clock
    });
    await this.rootFilesystem.ready();
    this.vfs = new VirtualFileSystem({ events: this.events, maxHandlesPerProcess: this.systemConfig.runtime?.maxHandlesPerProcess || 256 });
    this.diskManager = new DiskManager({ store: this.store, vfs: this.vfs, logger: this.logger, coordinator: this.coordinator });
    const rootBackend = this.store.volatile ? 'memory-volatile' : 'indexeddb';
    this.diskManager.register({ id: 'root', type: this.store.volatile ? 'memory' : 'indexeddb', filesystem: this.rootFilesystem, label: this.store.volatile ? 'Volatile Root (not persistent)' : 'NumiOS Persistent Root', backend: rootBackend, quota: this.systemConfig.storage?.rootQuotaBytes ?? null });
    const tempFilesystem = new TreeFileSystem({ store: new MemoryStore(), prefix: 'temp/', name: 'numios-temp', maxBytes: this.systemConfig.storage?.tempQuotaBytes ?? 16 * 1024 * 1024, owner: 'system', clock: this.clock });
    await tempFilesystem.ready();
    this.tempFilesystem = tempFilesystem;
    this.diskManager.register({ id: 'temp', type: 'memory', filesystem: tempFilesystem, label: 'Temporary Filesystem', backend: 'memory', quota: this.systemConfig.storage?.tempQuotaBytes ?? null });
    this.initializedStages.add('storage');
    await this.logger.info('storage', 'Persistent storage initialized.', { eventCode: 'STORAGE_READY', backend: this.store.constructor.name, interruptedPreviousBoot: this.interruptedPreviousBoot });
    return { backend: this.store.constructor.name, interruptedPreviousBoot: this.interruptedPreviousBoot };
  }

  async initializeCore() {
    this.#require('storage');
    this.#once('kernel');
    this.security = new SecurityManager({ policy: this.securityConfig, logger: this.logger });
    this.scheduler = new Scheduler({
      concurrency: this.systemConfig.runtime?.schedulerConcurrency || 4,
      maxQueue: this.systemConfig.runtime?.schedulerQueueLimit || 1000,
      defaultBudgetMs: this.systemConfig.runtime?.cooperativeTaskBudgetMs || 10000,
      events: this.events, clock: this.clock
    });
    this.resources = new ResourceManager({
      maxProcesses: this.systemConfig.runtime?.maxProcesses || 256,
      maxLogicalMemoryBytes: this.systemConfig.runtime?.maxLogicalMemoryBytes || 256 * 1024 * 1024,
      maxHandlesPerProcess: this.systemConfig.runtime?.maxHandlesPerProcess || 256,
      scheduler: this.scheduler
    });
    this.ipc = new IpcBus({ events: this.events, logger: this.logger });
    this.networkClient = new NetworkClient();
    this.processManager = new ProcessManager({
      security: this.security, scheduler: this.scheduler, resources: this.resources, vfs: this.vfs,
      ipc: this.ipc, logger: this.logger, events: this.events,
      maxProcesses: this.systemConfig.runtime?.maxProcesses || 256
    });
    this.deviceRegistry = new DeviceRegistry({
      logger: this.logger, networkClient: this.networkClient,
      storageStatus: () => this.diskManager.status()
    });
    await this.deviceRegistry.initialize();
    this.deviceFilesystem = new DeviceFileSystem(this.deviceRegistry);
    this.initializedStages.add('kernel');
    await this.logger.info('kernel', 'Kernel core components constructed.', { eventCode: 'KERNEL_CORE_READY', id: this.id });
    return { id: this.id, subsystems: ['security', 'scheduler', 'resources', 'processes', 'ipc', 'network', 'devices'] };
  }

  async registerSyscalls() {
    this.#require('kernel');
    this.#once('syscalls');
    this.registry = new SyscallRegistry(this.syscallTable);
    const handlers = this.#syscallHandlers();
    for (const [name, handler] of Object.entries(handlers)) this.registry.register(name, handler);
    this.registry.seal();
    this.dispatcher = new SyscallDispatcher({
      registry: this.registry, security: this.security, processManager: this.processManager,
      logger: this.logger, defaultTimeoutMs: this.systemConfig.runtime?.defaultSyscallTimeoutMs || 30000,
      maxTimeoutMs: this.systemConfig.runtime?.maxSyscallTimeoutMs || 120000
    });
    this.dispatcher.initialize();
    this.syscallHost = new SyscallHost(this.dispatcher);
    this.initializedStages.add('syscalls');
    await this.logger.info('syscall', 'Central syscall dispatcher registered and sealed.', { eventCode: 'SYSCALLS_READY', count: this.registry.list().length, version: this.registry.tableVersion });
    return this.dispatcher.status();
  }

  async initializeSecurity() {
    this.#require('syscalls');
    this.#once('security');
    this.security.audit({ eventCode: 'SECURITY_READY', outcome: 'initialized', principal: 'system', policy: 'capability-based' });
    this.initializedStages.add('security');
    return { principalCount: this.security.principals.size, systemCapabilityCount: this.security.systemCapabilities().length };
  }

  async initializeProcesses() {
    this.#require('security');
    this.#once('processes');
    this.workerRuntime = new WorkerRuntime({ syscallHost: this.syscallHost, processManager: this.processManager, logger: this.logger });
    this.initializedStages.add('processes');
    return { processManager: true, scheduler: this.scheduler.status(), workerAvailable: typeof Worker === 'function' };
  }

  async mountFilesystems() {
    this.#require('processes');
    this.#once('filesystems');
    await this.diskManager.mount('root', '/', { allowRoot: true });
    for (const path of REQUIRED_ROOT_DIRECTORIES) await this.vfs.mkdir(path, { recursive: true, mode: path === '/Users' || path === '/Users/demo' ? 0o777 : 0o755, owner: path === '/Users' || path === '/Users/demo' ? 'demo' : 'system' });
    await this.diskManager.mount('temp', '/Temp');
    await this.diskManager.restorePersistent();
    await this.#applyMountConfig(this.mountConfig);

    await this.#writeConfigText('/etc/system.json', this.systemConfig);
    await this.#writeConfigText('/etc/security.json', this.securityConfig);
    await this.#writeConfigText('/etc/repositories.json', this.repositoryConfig);
    await this.#writeConfigText('/etc/mounts.json', this.mountConfig);
    for (const definition of this.serviceDefinitions) {
      const filename = definition.unit?.name;
      if (!filename) throw new NumiOSError('SERVICE_UNIT_INVALID', 'Static service definition has no unit name.');
      await this.#seedText(`/System/Services/${filename}`, JSON.stringify(definition, null, 2));
    }
    const resourcesFS = new StaticFileSystem({ files: {
      '/version.json': JSON.stringify({ name: 'NumiOS', version: this.systemConfig.os?.version || '0.1.0', architecture: 'browser-native-esm' }, null, 2),
      '/capabilities.json': JSON.stringify({ browserOnly: true, rawBlockDevices: false, rawSockets: false, nativeShell: false }, null, 2)
    }, name: 'system-resources' });
    this.diskManager.register({ id: 'system-resources', type: 'static', filesystem: resourcesFS, label: 'Read-only system resources', backend: 'static', readOnly: true });
    await this.diskManager.mount('system-resources', '/System/Resources', { readOnly: true });

    await this.deviceRegistry.initializeDrivers();
    await this.vfs.mount(this.deviceFilesystem, '/dev', { id: 'device-filesystem', type: 'device', source: 'browser-resources', readOnly: false });
    this.procFilesystem = new ProcFilesystem({ providers: this.#procProviders() });
    await this.vfs.mount(this.procFilesystem, '/proc', { id: 'proc-filesystem', type: 'proc', source: 'kernel-state', readOnly: true });

    this.repositoryManager = new RepositoryManager({
      config: this.repositoryConfig, networkClient: this.networkClient, store: this.store,
      logger: this.logger, osVersion: this.systemConfig.os?.version || '0.1.0',
      trustedKeys: this.systemConfig.packages?.trustedKeys || {},
      trustedRepositoryIds: this.securityConfig.trustedRepositories || [],
      maxArchiveBytes: this.systemConfig.packages?.maximumArchiveBytes,
      maxUnpackedBytes: this.systemConfig.packages?.maximumUnpackedBytes
    });
    await this.repositoryManager.initialize();
    this.packageManager = new PackageManager({
      store: this.store, vfs: this.vfs, repositoryManager: this.repositoryManager,
      security: this.security, coordinator: this.coordinator, logger: this.logger,
      policy: this.systemConfig.packages || {}, osVersion: this.systemConfig.os?.version || '0.1.0'
    });
    this.applicationLoader = new ApplicationLoader({
      packageManager: this.packageManager, processManager: this.processManager, security: this.security,
      workerRuntime: this.workerRuntime, logger: this.logger, syscallHost: this.syscallHost
    });
    this.packageManager.applicationLoader = this.applicationLoader;
    const builtins = createBuiltinServices({ repositoryManager: this.repositoryManager, packageManager: this.packageManager });
    this.serviceManager = new ServiceManager({
      vfs: this.vfs, processManager: this.processManager, security: this.security, logger: this.logger,
      createSdk: (pid, identity) => this.#localSdkClient(pid, identity), builtins, workerRuntime: this.workerRuntime,
      schema: this.serviceSchema, events: this.events, clock: this.clock
    });
    this.diagnostics = new Diagnostics({
      getKernelStatus: () => this.status(), vfs: this.vfs, diskManager: this.diskManager,
      serviceManager: this.serviceManager, packageManager: this.packageManager, quotas: this.quotaManager,
      dispatcher: this.dispatcher, processManager: this.processManager, logger: this.logger
    });
    this.initializedStages.add('filesystems');
    await this.logger.info('fs', 'Persistent root, temporary, device, proc and static resource filesystems mounted.', { eventCode: 'FILESYSTEMS_READY', mounts: this.vfs.mounts().length });
    return { mounts: this.vfs.mounts(), disks: this.diskManager.list() };
  }

  async startServices() {
    this.#require('filesystems');
    this.#once('services');
    const recoveredPackages = await this.packageManager.recover();
    await this.applicationLoader.recover();
    await this.serviceManager.loadUnits();
    const serviceResult = await this.serviceManager.startAll();
    this.initializedStages.add('services');
    return { recoveredPackages, ...serviceResult };
  }

  async executeTarget(target = 'default.target') {
    this.#require('services');
    this.#once('target');
    if (!['default.target', 'recovery.target', 'recovery'].includes(target)) throw new NumiOSError('BOOT_TARGET_UNKNOWN', 'Configured boot target is not supported.', { target });
    this.activeTarget = target;
    if (target === 'recovery' || target === 'recovery.target') this.recoveryMode = true;
    this.initializedStages.add('target');
    return { target, recoveryMode: this.recoveryMode };
  }

  async markReady(bootInfo = null) {
    this.#require('target');
    this.#once('ready');
    this.ready = true;
    this.state = 'ready';
    this.bootInfo = bootInfo;
    this.initializedStages.add('ready');
    await this.store.set('lifecycle/boot-state', { state: 'ready', kernelId: this.id, readyAt: new Date(this.clock()).toISOString(), bootId: bootInfo?.bootId || null });
    await this.logger.info('kernel', 'NumiOS is ready.', { eventCode: 'SYSTEM_READY', kernelId: this.id, target: this.activeTarget });
    this.events.emit('system.ready', this.status());
    return this.status();
  }

  async shutdown({ reason = 'requested' } = {}) {
    if (this.state === 'stopped' || this.state === 'shutdown') return { state: this.state, reason: this.shutdownReason };
    this.state = 'shutting-down';
    this.ready = false;
    this.shutdownReason = reason;
    const errors = [];
    try { await this.serviceManager?.shutdown(); } catch (error) { errors.push({ subsystem: 'services', message: error.message }); }
    try { await this.processManager?.shutdown(); } catch (error) { errors.push({ subsystem: 'processes', message: error.message }); }
    try { await this.deviceRegistry?.shutdown(); } catch (error) { errors.push({ subsystem: 'devices', message: error.message }); }
    try { await this.scheduler?.shutdown(); } catch (error) { errors.push({ subsystem: 'scheduler', message: error.message }); }
    try {
      await this.store.set('lifecycle/boot-state', { state: 'shutdown', kernelId: this.id, stoppedAt: new Date(this.clock()).toISOString(), reason });
      await this.logger?.flush();
    } catch (error) { errors.push({ subsystem: 'persistence', message: error.message }); }
    try { this.coordinator?.close(); } catch (error) { errors.push({ subsystem: 'coordinator', message: error.message }); }
    this.state = 'stopped';
    await this.store.close?.();
    this.events.emit('system.shutdown', { reason, errors });
    return { state: this.state, reason, errors };
  }

  async reboot() {
    if (typeof this.rebootHandler !== 'function') throw new NumiOSError('REBOOT_UNAVAILABLE', 'Boot manager did not register a reboot handler.');
    return this.rebootHandler();
  }

  status() {
    return {
      name: this.systemConfig.os?.name || 'NumiOS', version: this.systemConfig.os?.version || '0.1.0',
      kernelId: this.id, state: this.state, ready: this.ready, recoveryMode: this.recoveryMode,
      uptimeMs: Math.max(0, this.clock() - this.startedAt), activeTarget: this.activeTarget,
      bootInfo: this.bootInfo, initializedStages: [...this.initializedStages],
      processes: this.processManager?.list() || [], services: this.serviceManager?.list() || [],
      mounts: this.vfs?.mounts() || [], disks: this.diskManager?.list() || [],
      resources: this.resources?.systemUsage(this.processManager?.list().filter(p => !['terminated', 'failed'].includes(p.state)).length) || null,
      syscalls: this.dispatcher?.status() || null,
      health: this.diagnostics?.health || { healthy: false, checks: [] }
    };
  }

  systemInfo() {
    return {
      name: this.systemConfig.os?.name || 'NumiOS', version: this.systemConfig.os?.version || '0.1.0', architecture: 'browser-native-esm',
      executionEnvironment: 'modern-web-browser', origin: globalThis.location?.origin || null,
      secureContext: Boolean(globalThis.isSecureContext), userAgent: globalThis.navigator?.userAgent || null,
      limitations: { nativeExecutable: false, serverRequiredForRuntime: false, rawBlockDevices: false, rawTcpUdp: false, arbitraryLocalPaths: false, backgroundServicesAfterClose: false },
      features: {
        indexedDB: Boolean(globalThis.indexedDB), opfs: Boolean(globalThis.navigator?.storage?.getDirectory),
        storageEstimate: Boolean(globalThis.navigator?.storage?.estimate), persistentStorage: Boolean(globalThis.navigator?.storage?.persist),
        worker: typeof Worker === 'function', serviceWorker: Boolean(globalThis.navigator?.serviceWorker),
        fileSystemAccess: typeof globalThis.showDirectoryPicker === 'function', broadcastChannel: typeof BroadcastChannel === 'function',
        webLocks: Boolean(globalThis.navigator?.locks), cryptoSubtle: Boolean(globalThis.crypto?.subtle), clipboard: Boolean(globalThis.navigator?.clipboard), fetch: typeof globalThis.fetch === 'function'
      },
      syscallVersion: this.registry?.tableVersion || null, sdkVersion: '1.0.0'
    };
  }

  createApplicationPort(pid) {
    const channel = new MessageChannel();
    const detach = this.syscallHost.attach(channel.port1, `pid:${pid}`);
    this.processManager.addCleanup(pid, detach);
    return { port: channel.port2, detach };
  }

  #localSdkClient(pid, identity = {}) {
    const client = new SyscallClientShim(this.dispatcher, `pid:${pid}`);
    const serviceName = identity.serviceName || `service-${pid}`;
    return createServiceSDK(client, { pid, applicationId: serviceName, name: serviceName });
  }

  #assertConfigMutation(name, value) {
    if (name !== 'system') return;
    const before = this.systemConfig.storage || {};
    const after = value?.storage || {};
    for (const key of ['backend', 'databaseName', 'databaseVersion', 'allowEphemeralRoot']) {
      if (Object.hasOwn(after, key) && after[key] !== before[key]) throw new NumiOSError('CONFIG_IMMUTABLE', `System storage setting '${key}' is fixed for the lifetime of this kernel.`, { key });
    }
  }

  async #assignConfig(name, value) {
    if (name === 'system') {
      this.#assertConfigMutation(name, value);
      this.systemConfig = value;
      if (value.logging?.level) this.logger.level = value.logging.level;
      if (Number.isSafeInteger(value.logging?.capacity)) {
        this.logger.capacity = value.logging.capacity;
        if (this.logger.records.length > this.logger.capacity) this.logger.records.splice(0, this.logger.records.length - this.logger.capacity);
      }
      if (Number.isSafeInteger(value.storage?.rootQuotaBytes)) {
        this.rootFilesystem.maxBytes = value.storage.rootQuotaBytes;
        this.quotaManager.logicalLimits.rootBytes = value.storage.rootQuotaBytes;
      }
      if (Number.isSafeInteger(value.storage?.tempQuotaBytes)) {
        this.tempFilesystem.maxBytes = value.storage.tempQuotaBytes;
        this.quotaManager.logicalLimits.tempBytes = value.storage.tempQuotaBytes;
      }
      if (value.storage?.requestPersistentStorage) await this.quotaManager.requestPersistence();
      const runtime = value.runtime || {};
      if (Number.isSafeInteger(runtime.maxProcesses)) this.processManager.maxProcesses = this.resources.maxProcesses = runtime.maxProcesses;
      if (Number.isSafeInteger(runtime.maxLogicalMemoryBytes)) this.resources.maxLogicalMemoryBytes = runtime.maxLogicalMemoryBytes;
      if (Number.isSafeInteger(runtime.maxHandlesPerProcess)) this.vfs.maxHandlesPerProcess = this.resources.maxHandlesPerProcess = runtime.maxHandlesPerProcess;
      if (Number.isSafeInteger(runtime.schedulerConcurrency)) this.scheduler.concurrency = runtime.schedulerConcurrency;
      if (Number.isSafeInteger(runtime.schedulerQueueLimit)) this.scheduler.maxQueue = runtime.schedulerQueueLimit;
      if (Number.isSafeInteger(runtime.cooperativeTaskBudgetMs)) this.scheduler.defaultBudgetMs = runtime.cooperativeTaskBudgetMs;
      if (Number.isSafeInteger(runtime.defaultSyscallTimeoutMs)) this.dispatcher.defaultTimeoutMs = runtime.defaultSyscallTimeoutMs;
      if (Number.isSafeInteger(runtime.maxSyscallTimeoutMs)) this.dispatcher.maxTimeoutMs = runtime.maxSyscallTimeoutMs;
      this.packageManager.policy = value.packages || {};
      if (this.repositoryManager) {
        this.repositoryManager.trustedKeys = value.packages?.trustedKeys || {};
        this.repositoryManager.maxArchiveBytes = value.packages?.maximumArchiveBytes || 32 * 1024 * 1024;
        this.repositoryManager.maxUnpackedBytes = value.packages?.maximumUnpackedBytes || 64 * 1024 * 1024;
      }
    } else if (name === 'security') {
      this.securityConfig = value;
      this.security.updatePolicy(value);
      if (this.repositoryManager) this.repositoryManager.trustedRepositoryIds = new Set(value.trustedRepositories || []);
    } else if (name === 'repositories') {
      this.repositoryConfig = value;
      if (this.repositoryManager) {
        this.repositoryManager.config = value;
        this.repositoryManager.initialized = false;
        this.repositoryManager.indexCache.clear();
        await this.repositoryManager.initialize();
      }
    } else if (name === 'mounts') {
      await this.#applyMountConfig(value);
      this.mountConfig = value;
    }
    return value;
  }

  async #writeConfigText(path, value) {
    await this.vfs.writeFile(path, JSON.stringify(value, null, 2), { create: true, owner: 'system' });
  }

  #normalizeMountEntry(entry) {
    if (!entry || typeof entry.diskId !== 'string' || typeof entry.mountPoint !== 'string') throw new NumiOSError('MOUNT_CONFIG_INVALID', 'Mount entries require a disk id and virtual mount point.');
    if (entry.mountPoint.length > 4096) throw new NumiOSError('MOUNT_CONFIG_INVALID', 'Mount point exceeds the maximum supported length.');
    const mountPoint = normalizePath(entry.mountPoint);
    if (!mountPoint.startsWith('/Volumes/')) throw new NumiOSError('MOUNT_CONFIG_INVALID', 'Configurable disks may only be mounted beneath /Volumes/.', { mountPoint });
    if (entry.readOnly !== undefined && typeof entry.readOnly !== 'boolean') throw new NumiOSError('MOUNT_CONFIG_INVALID', 'Mount readOnly must be boolean.');
    if (entry.optional !== undefined && typeof entry.optional !== 'boolean') throw new NumiOSError('MOUNT_CONFIG_INVALID', 'Mount optional must be boolean.');
    return { diskId: entry.diskId, mountPoint, readOnly: Boolean(entry.readOnly), optional: Boolean(entry.optional) };
  }

  async #ensureMountDirectory(mountPoint) {
    try {
      const stat = await this.vfs.stat(mountPoint);
      if (stat.type !== 'directory') throw new NumiOSError('NOT_A_DIRECTORY', 'Configured mount point is not a directory.', { mountPoint });
    } catch (error) {
      if (error.code !== 'NOT_FOUND') throw error;
      await this.vfs.mkdir(mountPoint, { recursive: true, mode: 0o755, owner: 'system' });
    }
  }

  async #applyMountConfig(value) {
    if (!value || !Array.isArray(value.mounts)) throw new NumiOSError('MOUNT_CONFIG_INVALID', 'Mount configuration must contain a mounts array.');
    const desired = new Map();
    const mountPoints = new Set();
    for (const raw of value.mounts) {
      const entry = this.#normalizeMountEntry(raw);
      if (desired.has(entry.diskId) || mountPoints.has(entry.mountPoint)) throw new NumiOSError('MOUNT_CONFIG_INVALID', 'Mount configuration contains duplicate disks or mount points.');
      desired.set(entry.diskId, entry);
      mountPoints.add(entry.mountPoint);
    }
    for (const [diskId, previous] of [...this.configuredMounts]) {
      const next = desired.get(diskId);
      if (next && next.mountPoint === previous.mountPoint && next.readOnly === previous.readOnly) continue;
      await this.diskManager.unmount(diskId);
      this.configuredMounts.delete(diskId);
    }
    for (const [diskId, entry] of desired) {
      const previous = this.configuredMounts.get(diskId);
      if (previous && previous.mountPoint === entry.mountPoint && previous.readOnly === entry.readOnly) continue;
      const disk = this.diskManager.get(diskId);
      if (!disk) {
        if (entry.optional) continue;
        throw new NumiOSError('DISK_NOT_FOUND', 'Configured disk is not registered.', { diskId });
      }
      if (disk.state === 'mounted') throw new NumiOSError('ALREADY_MOUNTED', 'Configured disk is already mounted elsewhere.', { diskId, mountPoint: disk.mountPoint });
      await this.#ensureMountDirectory(entry.mountPoint);
      await this.diskManager.mount(diskId, entry.mountPoint, { readOnly: entry.readOnly });
      this.configuredMounts.set(diskId, entry);
    }
    return [...this.configuredMounts.values()].map(entry => ({ ...entry }));
  }

  async #mountDisk(diskId, mountPoint, { readOnly = false, persist = true } = {}) {
    const entry = this.#normalizeMountEntry({ diskId, mountPoint, readOnly, optional: false });
    if ([...this.configuredMounts.values()].some(current => current.mountPoint === entry.mountPoint)) throw new NumiOSError('ALREADY_MOUNTED', 'A configured mount already uses this mount point.', { mountPoint: entry.mountPoint });
    await this.#ensureMountDirectory(entry.mountPoint);
    const result = await this.diskManager.mount(entry.diskId, entry.mountPoint, { readOnly: entry.readOnly });
    if (persist) {
      this.configuredMounts.set(entry.diskId, entry);
      try { await this.#persistMountConfig(); }
      catch (error) {
        this.configuredMounts.delete(entry.diskId);
        await this.diskManager.unmount(entry.diskId, { force: true }).catch(() => {});
        throw error;
      }
    }
    return result;
  }

  async #persistMountConfig() {
    const mounts = [...this.configuredMounts.values()].map(entry => ({ ...entry }));
    const updated = await this.configManager.update('mounts', current => ({ ...current, mounts }));
    this.mountConfig = updated;
    await this.#writeConfigText('/etc/mounts.json', updated);
    return updated;
  }

  async #unmountDisk(diskId, options = {}) {
    const result = await this.diskManager.unmount(diskId, options);
    if (this.configuredMounts.delete(diskId)) await this.#persistMountConfig();
    return result;
  }

  async #seedText(path, text) {
    try { await this.vfs.stat(path); return false; }
    catch (error) {
      if (error.code !== 'NOT_FOUND') throw error;
      await this.vfs.writeFile(path, text, { create: true, mode: 0o644, owner: 'system' });
      return true;
    }
  }

  #procProviders() {
    return {
      version: async () => JSON.stringify({ name: this.systemConfig.os?.name || 'NumiOS', version: this.systemConfig.os?.version || '0.1.0', architecture: 'browser-native-esm' }, null, 2),
      uptime: async () => String(this.clock() - this.startedAt),
      processes: async () => this.processManager.list(),
      mounts: async () => this.vfs.mounts(),
      services: async () => this.serviceManager?.list() || [],
      memory: async () => this.resources.systemUsage(this.processManager.list().filter(p => !['terminated', 'failed'].includes(p.state)).length),
      syscalls: async () => this.dispatcher.list(),
      storage: async () => this.diskManager.status(),
      health: async () => this.diagnostics.run()
    };
  }

  #syscallHandlers() {
    const h = {};
    const add = (name, fn) => { h[name] = fn; };
    const path = (identity, value, operation) => {
      const normalized = normalizePath(value);
      this.security.assertPathAccess(identity, normalized, operation);
      return normalized;
    };
    const processAccessible = (identity, pid) => {
      if (identity.id === 'system' || identity.processId === pid) return;
      const process = this.processManager.get(pid);
      if (process?.parentPid === identity.processId) return;
      this.security.assertCapability(identity, 'process.manage');
    };

    add('process.create', (args, ctx) => this.processManager.create({
      caller: ctx.callerId, parentPid: args.parentPid, name: args.name, type: args.type || 'task', args: args.args,
      env: args.env, capabilities: args.capabilities, priority: args.priority, resourceLimits: args.resourceLimits
    }));
    add('process.spawn', async (args, ctx) => {
      const executable = normalizePath(args.executable);
      const parts = executable.split('/').filter(Boolean);
      if (parts[0] !== 'Apps' || !parts[1]) throw new NumiOSError('EXECUTABLE_NOT_FOUND', 'process.spawn currently launches installed NPP applications under /Apps/<id>.');
      return this.applicationLoader.launch(parts[1], { args: args.args || [], env: args.env || {}, identity: ctx.callerId, priority: args.priority || 0 });
    });
    add('process.exit', async (args, ctx) => {
      if (ctx.identity.id !== 'system' && ctx.identity.processId !== args.pid) throw new NumiOSError('PROCESS_ACCESS_DENIED', 'A process can only exit itself.');
      return this.processManager.terminate(args.pid, { caller: ctx.callerId, exitCode: args.exitCode || 0 });
    });
    add('process.signal', (args, ctx) => this.processManager.signal(args.pid, args.signal, { caller: ctx.callerId }));
    add('process.wait', (args, ctx) => { processAccessible(ctx.identity, args.pid); return this.processManager.wait(args.pid, { signal: ctx.signal, timeoutMs: args.timeoutMs }); });
    add('process.list', (_args, ctx) => this.processManager.list());
    add('process.get', (args, ctx) => { processAccessible(ctx.identity, args.pid); return this.processManager.get(args.pid); });
    add('process.suspend', (args, ctx) => this.processManager.suspend(args.pid, { caller: ctx.callerId }));
    add('process.resume', (args, ctx) => this.processManager.resume(args.pid, { caller: ctx.callerId }));

    add('fs.open', async (args, ctx) => {
      const normalized = path(ctx.identity, args.path, args.mode === 'read' || !args.mode ? 'read' : 'write');
      return this.vfs.open(normalized, { ...args, identity: ctx.identity });
    });
    add('fs.close', (args, ctx) => this.vfs.close(args.fd, { identity: ctx.identity }));
    add('fs.read', async (args, ctx) => {
      if (args.fd !== undefined) {
        const filePath = this.vfs.descriptorPath(args.fd, ctx.identity);
        path(ctx.identity, filePath, 'read');
        return decodeFileData(await this.vfs.read(args.fd, { length: args.length, offset: args.offset, signal: ctx.signal, identity: ctx.identity }), args.encoding || 'bytes');
      }
      if (!args.path) throw new NumiOSError('INVALID_ARGUMENT', 'fs.read requires either fd or path.');
      const normalized = path(ctx.identity, args.path, 'read');
      let bytes = await this.vfs.readFile(normalized, { length: args.length, identity: ctx.identity, signal: ctx.signal });
      if (args.offset) bytes = bytes.slice(args.offset);
      if (args.length !== undefined) bytes = bytes.slice(0, args.length);
      return decodeFileData(bytes, args.encoding || 'bytes');
    });
    add('fs.write', async (args, ctx) => {
      const input = decodeInput(args.data, args.encoding);
      if (args.fd !== undefined) {
        const filePath = this.vfs.descriptorPath(args.fd, ctx.identity);
        path(ctx.identity, filePath, 'write');
        return this.vfs.write(args.fd, input, { offset: args.offset, signal: ctx.signal, identity: ctx.identity });
      }
      if (!args.path) throw new NumiOSError('INVALID_ARGUMENT', 'fs.write requires either fd or path.');
      const normalized = path(ctx.identity, args.path, 'write');
      if (args.offset === undefined) return this.vfs.writeFile(normalized, input, { create: args.create !== false, owner: ctx.identity.uid, identity: ctx.identity });
      let existing;
      try {
        const stat = await this.vfs.stat(normalized);
        if (stat.type === 'device') return this.vfs.writeFile(normalized, input, { create: args.create !== false, owner: ctx.identity.uid, identity: ctx.identity });
        if (stat.type !== 'file') throw new NumiOSError('NOT_A_FILE', 'Offset writes require a regular file.');
        existing = await this.vfs.readFile(normalized, { identity: ctx.identity });
      } catch (error) {
        if (error.code !== 'NOT_FOUND' || args.create === false) throw error;
        existing = new Uint8Array();
      }
      const bytes = input;
      if (args.offset > MAX_FILE_BYTES || args.offset + bytes.byteLength > MAX_FILE_BYTES) throw new NumiOSError('RESOURCE_LIMIT', 'Offset write exceeds the maximum supported file size.');
      const updated = new Uint8Array(Math.max(existing.byteLength, args.offset + bytes.byteLength));
      updated.set(existing);
      updated.set(bytes, args.offset);
      return this.vfs.writeFile(normalized, updated, { create: args.create !== false, owner: ctx.identity.uid, identity: ctx.identity });
    });
    add('fs.stat', (args, ctx) => { const normalized = path(ctx.identity, args.path, 'read'); return this.vfs.stat(normalized); });
    add('fs.readdir', (args, ctx) => { const normalized = path(ctx.identity, args.path, 'read'); return this.vfs.readdir(normalized, { identity: ctx.identity }); });
    add('fs.mkdir', (args, ctx) => { const normalized = path(ctx.identity, args.path, 'write'); return this.vfs.mkdir(normalized, { ...args, identity: ctx.identity, owner: ctx.identity.uid }); });
    add('fs.unlink', (args, ctx) => { const normalized = path(ctx.identity, args.path, 'delete'); return this.vfs.unlink(normalized, { ...args, identity: ctx.identity }); });
    add('fs.rename', (args, ctx) => {
      const from = path(ctx.identity, args.from, 'rename'); const to = path(ctx.identity, args.to, 'rename');
      return this.vfs.rename(from, to, { identity: ctx.identity });
    });
    add('fs.copy', (args, ctx) => {
      const from = path(ctx.identity, args.from, 'read'); const to = path(ctx.identity, args.to, 'write');
      return this.vfs.copy(from, to, { identity: ctx.identity });
    });
    add('fs.resolve', async (args, ctx) => { const normalized = path(ctx.identity, args.path, 'read'); return this.vfs.resolve(normalized); });
    add('fs.realpath', (args, ctx) => { const normalized = path(ctx.identity, args.path, 'read'); return this.vfs.realpath(normalized); });
    add('fs.access', async (args, ctx) => {
      const normalized = path(ctx.identity, args.path, args.mode === 'write' || args.mode === 'readwrite' ? 'write' : 'read');
      try { return await this.vfs.access(normalized, { identity: ctx.identity, mode: args.mode || 'read' }); }
      catch { return false; }
    });
    add('fs.chmod', (args, ctx) => { const normalized = path(ctx.identity, args.path, 'chmod'); return this.vfs.chmod(normalized, args.mode, { identity: ctx.identity, owner: args.owner }); });
    add('fs.mount', async (args, ctx) => {
      const mountPoint = path(ctx.identity, args.mountPoint, 'mount');
      return this.#mountDisk(args.diskId, mountPoint, { readOnly: args.readOnly });
    });
    add('fs.unmount', (args, ctx) => this.#unmountDisk(args.diskId, { force: args.force }));

    add('memory.allocate', (args, ctx) => this.resources.allocate(ctx.identity.processId ?? 0, args.bytes, { label: args.label }));
    add('memory.release', (args, ctx) => this.resources.release(args.leaseId, ctx.identity.processId ?? 0));
    add('resource.get', (args, ctx) => {
      if (!args.resource || args.resource === 'system') this.security.assertCapability(ctx.identity, 'system.info');
      if (args.resource && !['memory', 'system', 'scheduler'].includes(args.resource)) throw new NumiOSError('RESOURCE_NOT_FOUND', 'Unknown logical resource.', { resource: args.resource });
      if (args.resource === 'scheduler') return this.scheduler.status();
      return args.resource === 'memory' && ctx.identity.processId !== null ? this.resources.usage(ctx.identity.processId) : this.resources.systemUsage(this.processManager.list().filter(process => !['terminated', 'failed'].includes(process.state)).length);
    });
    add('resource.limit', (args, ctx) => {
      const pid = args.pid ?? ctx.identity.processId ?? 0;
      if (pid !== (ctx.identity.processId ?? 0) && ctx.identity.id !== 'system') this.security.assertCapability(ctx.identity, 'process.manage');
      return this.resources.limit(pid, args.resource, args.value);
    });
    add('resource.usage', (args, ctx) => {
      const pid = args.pid ?? ctx.identity.processId;
      if (pid !== undefined && pid !== null && ctx.identity.id !== 'system') processAccessible(ctx.identity, pid);
      return pid === undefined || pid === null ? this.resources.systemUsage(this.processManager.list().length) : this.resources.usage(pid);
    });

    add('ipc.create', (args, ctx) => {
      if (args.scope && args.scope !== 'process') this.security.assertCapability(ctx.identity, 'ipc.share');
      return this.ipc.create({ ...args, owner: ctx.identity });
    });
    add('ipc.send', (args, ctx) => this.ipc.send(args.channelId, args.message, { sender: ctx.identity }));
    add('ipc.receive', (args, ctx) => this.ipc.receive(args.channelId, { ...args, principal: ctx.identity, signal: ctx.signal }));
    add('ipc.subscribe', (args, ctx) => this.ipc.subscribe(args.channelId, { principal: ctx.identity, signal: ctx.signal }));
    add('ipc.unsubscribe', (args, ctx) => this.ipc.unsubscribe(args.channelId, args.subscriptionId, { principal: ctx.identity }));
    add('ipc.close', (args, ctx) => this.ipc.close(args.channelId, { principal: ctx.identity }));

    add('service.register', (args, ctx) => this.serviceManager.register(args.definition, { identity: ctx.identity, persist: true }));
    add('service.start', (args) => this.serviceManager.start(args.name));
    add('service.stop', (args) => this.serviceManager.stop(args.name));
    add('service.restart', (args) => this.serviceManager.restart(args.name));
    add('service.status', args => this.serviceManager.status(args.name));
    add('service.list', args => this.serviceManager.list(args));
    add('service.logs', args => this.serviceManager.logs(args.name, args.limit));

    add('package.install', (args, ctx) => this.packageManager.install({ ...args, identity: ctx.identity, signal: ctx.signal }));
    add('package.remove', (args, ctx) => this.packageManager.remove(args.id, { ...args, identity: ctx.identity, signal: ctx.signal }));
    add('package.update', (args, ctx) => this.packageManager.update(args.id, { identity: ctx.identity, signal: ctx.signal }));
    add('package.query', args => this.packageManager.query(args.id));
    add('package.list', args => this.packageManager.list(args));
    add('app.launch', (args, ctx) => this.applicationLoader.launch(args.id, { ...args, identity: ctx.identity }));
    add('app.terminate', (args, ctx) => this.applicationLoader.terminate(args.pid, { identity: ctx.identity }));
    add('app.list', args => args.id ? this.applicationLoader.status(args.id) : this.applicationLoader.list());

    add('system.info', () => this.systemInfo());
    add('system.status', () => this.status());
    add('system.shutdown', args => this.shutdown({ reason: args.reason || 'syscall' }));
    add('system.reboot', () => this.reboot());
    add('config.get', args => this.configManager.get(args.name));
    add('config.list', () => this.configManager.list());
    add('config.update', async args => {
      this.#assertConfigMutation(args.name, args.value);
      const updated = await this.configManager.update(args.name, () => args.value);
      await this.#assignConfig(args.name, updated);
      await this.vfs.writeFile(`/etc/${args.name}.json`, JSON.stringify(updated, null, 2), { create: true, owner: 'system' });
      return updated;
    });
    add('config.reload', async args => {
      const text = new TextDecoder().decode(await this.vfs.readFile(`/etc/${args.name}.json`));
      const updated = parseJson(text, `${args.name}.json`);
      this.#assertConfigMutation(args.name, updated);
      const result = await this.configManager.update(args.name, () => updated);
      await this.#assignConfig(args.name, result);
      return result;
    });
    add('security.check', (args, ctx) => {
      try {
        if (args.path) this.security.assertPathAccess(ctx.identity, normalizePath(args.path), args.operation || 'read');
        else this.security.assertCapability(ctx.identity, args.capability);
        return { allowed: true };
      } catch (error) { return { allowed: false, code: error.code || 'CAPABILITY_DENIED', message: error.message }; }
    });
    add('security.requestCapability', (args, ctx) => this.security.requestCapability(ctx.identity, args.capability, args.reason));
    add('security.audit', args => this.security.auditLog(args));
    add('network.request', (args, ctx) => this.networkClient.request({ ...args, signal: ctx.signal }));
    add('device.list', () => this.deviceRegistry.list());
    add('disk.list', () => this.diskManager.status());
    add('repository.list', () => this.repositoryManager.list());
    add('repository.query', (args, ctx) => this.repositoryManager.query(args.packageId, { range: args.range || '*', signal: ctx.signal }));
    add('repository.refresh', (args, ctx) => this.repositoryManager.refresh(args.id || null, { signal: ctx.signal }));
    add('repository.local.create', async args => {
      await this.repositoryManager.createLocalRepository(args);
      return this.repositoryManager.list().find(repository => repository.id === args.id);
    });
    add('repository.local.publish', args => this.repositoryManager.publishLocal(args.repositoryId, args.archive));
    add('repository.local.remove', args => this.repositoryManager.removeLocal(args.repositoryId, args.packageId, args.version));
    add('disk.create', async args => {
      const disk = await this.diskManager.create(args);
      if (args.mountPoint) return this.#mountDisk(disk.id, args.mountPoint, { readOnly: args.readOnly });
      return disk;
    });
    add('disk.authorizeDirectory', async args => {
      const disk = await this.diskManager.authorizeDirectory({ id: args.id, readOnly: args.readOnly, handle: args.handle });
      if (args.mountPoint) return this.#mountDisk(disk.id, args.mountPoint, { readOnly: args.readOnly, persist: false });
      return disk;
    });
    add('log.query', args => this.logger.query(args));
    add('log.write', async (args, ctx) => this.logger.log(args.severity, args.subsystem, args.message, args.metadata || {}, ctx.identity.id, ctx.requestId));
    add('syscall.list', () => this.dispatcher.list());
    add('diagnostics.run', () => this.diagnostics.run());
    return h;
  }

  #once(stage) {
    if (this.initializedStages.has(stage)) throw new NumiOSError('BOOT_STAGE_REPEATED', `Kernel stage '${stage}' was initialized more than once.`);
  }
  #require(stage) { if (!this.initializedStages.has(stage)) throw new NumiOSError('KERNEL_DEPENDENCY_MISSING', `Kernel stage '${stage}' must run first.`); }
}

class SyscallClientShim {
  constructor(dispatcher, callerId) { this.dispatcher = dispatcher; this.callerId = callerId; }
  call(name, args, options = {}) { return this.dispatcher.call(name, args, { ...options, callerId: this.callerId }); }
  close() {}
}

function decodeInput(value, encoding) {
  if (encoding === 'base64') {
    if (typeof value !== 'string') throw new NumiOSError('INVALID_ARGUMENT', 'Base64 filesystem writes require string data.');
    if (value.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4) throw new NumiOSError('RESOURCE_LIMIT', 'Filesystem write exceeds the maximum supported file size.');
    try {
      const binary = atob(value);
      if (binary.length > MAX_FILE_BYTES) throw new NumiOSError('RESOURCE_LIMIT', 'Filesystem write exceeds the maximum supported file size.');
      return Uint8Array.from(binary, char => char.charCodeAt(0));
    } catch (error) {
      if (error instanceof NumiOSError) throw error;
      throw new NumiOSError('INVALID_ARGUMENT', 'Filesystem write data is not valid base64.');
    }
  }
  let bytes;
  if (value instanceof Uint8Array) bytes = value;
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else if (typeof value === 'string') bytes = new TextEncoder().encode(value);
  else if (Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) bytes = new Uint8Array(value);
  else throw new NumiOSError('INVALID_ARGUMENT', 'Filesystem write data must be text or bytes.');
  if (bytes.byteLength > MAX_FILE_BYTES) throw new NumiOSError('RESOURCE_LIMIT', 'Filesystem write exceeds the maximum supported file size.');
  return bytes;
}

function defaultSystemConfig() {
  return { schemaVersion: 1, os: { name: 'NumiOS', version: '0.1.0', architecture: 'browser-native-esm' }, storage: { backend: 'indexeddb', databaseName: 'numios', databaseVersion: 1, rootQuotaBytes: 67108864, tempQuotaBytes: 16777216, requestPersistentStorage: true, allowEphemeralRoot: false }, runtime: {}, logging: { level: 'info', capacity: 2000 }, packages: { allowUnsignedLocal: false, trustedKeys: {}, maximumArchiveBytes: 33554432, maximumUnpackedBytes: 67108864 }, applications: { allowDom: false, workerOnly: true } };
}
function defaultSecurityConfig() { return { schemaVersion: 1, applicationCapabilityAllowlist: ['fs.read.user', 'fs.write.user', 'fs.read.application', 'fs.read.library', 'fs.read.temp', 'fs.write.temp', 'network.fetch', 'package.query', 'system.info', 'ipc.use'], denyLaunchWithUnapprovedCapabilities: true, trustedRepositories: [], protectedPaths: ['/System', '/usr', '/bin', '/lib', '/etc', '/var/lib/numios'] }; }
function structuredCloneSafe(value) { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
