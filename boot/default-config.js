export const DEFAULT_BOOT_CONFIG = Object.freeze({
  schemaVersion: 1, bootId: 'numios-recovery-default', timeoutMs: 30000, stageTimeoutMs: 15000,
  retry: { storage: 1, services: 0 }, recovery: { enabled: true, safeTarget: 'recovery.target', continueWithoutOptionalServices: true },
  serviceTarget: 'default.target', registerServiceWorker: true, mounts: [],
  serviceUnits: ['../services/definitions/storage.service', '../services/definitions/logging.service', '../services/definitions/ipc.service', '../services/definitions/package-repositories.service', '../services/definitions/system-monitor.service'],
  stages: ['configuration', 'storage', 'kernel', 'syscalls', 'security', 'processes', 'filesystems', 'services', 'target', 'ready']
});

export const DEFAULT_SYSTEM_CONFIG = Object.freeze({
  schemaVersion: 1, os: { name: 'NumiOS', version: '0.1.0', architecture: 'browser-native-esm' },
  storage: { backend: 'indexeddb', databaseName: 'numios', databaseVersion: 1, rootQuotaBytes: 67108864, tempQuotaBytes: 16777216, requestPersistentStorage: true, allowEphemeralRoot: false },
  runtime: { maxProcesses: 256, maxLogicalMemoryBytes: 268435456, maxHandlesPerProcess: 256, cooperativeTaskBudgetMs: 10000, defaultSyscallTimeoutMs: 30000, maxSyscallTimeoutMs: 120000 },
  logging: { level: 'info', capacity: 2000 },
  applications: { allowDom: false, workerOnly: true },
  packages: { allowUnsignedLocal: false, trustedKeys: {}, maximumArchiveBytes: 33554432, maximumUnpackedBytes: 67108864 }
});

export const DEFAULT_SECURITY_CONFIG = Object.freeze({
  schemaVersion: 1,
  applicationCapabilityAllowlist: ['fs.read.user', 'fs.write.user', 'fs.read.application', 'fs.read.library', 'fs.read.temp', 'fs.write.temp', 'network.fetch', 'package.query', 'system.info', 'ipc.use'],
  denyLaunchWithUnapprovedCapabilities: true, trustedRepositories: [], protectedPaths: ['/System', '/usr', '/bin', '/lib', '/etc', '/var/lib/numios']
});
