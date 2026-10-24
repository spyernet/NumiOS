import { EventHub } from '../core/events.js';
import { createId } from '../core/ids.js';
import { NumiOSError } from '../core/errors.js';
import { DEFAULT_BOOT_CONFIG } from './default-config.js';
import { RecoveryManager, validateBootConfig } from './recovery.js';

const DEPENDENCIES = Object.freeze({
  configuration: [], storage: ['configuration'], kernel: ['storage'], syscalls: ['kernel'], security: ['syscalls'],
  processes: ['security'], filesystems: ['processes'], services: ['filesystems'], target: ['services'], ready: ['target']
});

export class BootManager {
  constructor({ config = DEFAULT_BOOT_CONFIG, configError = null, createKernel, store = null, logger = null, events = new EventHub(), recoveryManager = null, clock = () => Date.now() } = {}) {
    this.config = config;
    this.configError = configError;
    this.createKernel = createKernel;
    this.store = store;
    this.logger = logger;
    this.events = events;
    this.clock = clock;
    this.recovery = recoveryManager || new RecoveryManager({ store, logger, events });
    this.kernel = null;
    this.state = 'cold';
    this.stageRecords = [];
    this.bootId = config?.bootId || createId('boot');
    this.startedAt = null;
    this.finishedAt = null;
    this.error = null;
    this.recoveryMode = Boolean(configError);
  }

  async boot() {
    if (this.state === 'ready') return this.status();
    if (this.state === 'booting') throw new NumiOSError('BOOT_IN_PROGRESS', 'NumiOS boot is already in progress.');
    if (this.state === 'recovery') throw new NumiOSError('BOOT_RECOVERY_REQUIRED', 'Boot is in recovery state. Reboot after correcting configuration or storage.');
    this.state = 'booting';
    this.startedAt = this.clock();
    this.finishedAt = null;
    this.error = null;
    this.stageRecords = [];
    const overallDeadline = this.startedAt + (this.config?.timeoutMs || DEFAULT_BOOT_CONFIG.timeoutMs);
    const expectedStages = ['configuration', 'storage', 'kernel', 'syscalls', 'security', 'processes', 'filesystems', 'services', 'target', 'ready'];
    try {
      for (const stage of expectedStages) {
        const dependencies = DEPENDENCIES[stage];
        const record = { stage, dependencies, state: 'pending', startedAt: null, endedAt: null, durationMs: null, attempts: 0, error: null, data: null };
        this.stageRecords.push(record);
        this.#progress(record);
        const retries = stage === 'storage' ? (this.config?.retry?.storage || 0) : stage === 'services' ? (this.config?.retry?.services || 0) : 0;
        let lastError;
        for (let attempt = 0; attempt <= retries; attempt += 1) {
          record.attempts = attempt + 1;
          try {
            record.data = await this.#runStage(stage, overallDeadline);
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            if (attempt < retries) await this.#log('warn', 'Boot stage retry scheduled.', { eventCode: 'BOOT_STAGE_RETRY', stage, attempt: attempt + 1, code: error.code || 'BOOT_STAGE_FAILED' });
          }
        }
        if (lastError) throw Object.assign(lastError, { bootStage: stage });
        record.state = 'complete';
        record.endedAt = this.clock();
        record.durationMs = record.endedAt - record.startedAt;
        this.#progress(record);
      }
      this.state = 'ready';
      this.finishedAt = this.clock();
      await this.#log('info', 'NumiOS boot completed.', { eventCode: 'BOOT_COMPLETE', bootId: this.bootId, durationMs: this.finishedAt - this.startedAt, recoveryMode: this.recoveryMode });
      this.events.emit('boot.complete', this.status());
      return this.status();
    } catch (error) {
      const stageName = error.bootStage || this.stageRecords.find(record => record.state === 'pending')?.stage || 'unknown';
      const record = this.stageRecords.find(item => item.stage === stageName);
      if (record) {
        record.state = 'failed';
        record.endedAt = this.clock();
        record.durationMs = record.startedAt === null ? 0 : record.endedAt - record.startedAt;
        record.error = { code: error.code || 'BOOT_STAGE_FAILED', message: error.message };
        this.#progress(record);
      }
      this.error = { code: error.code || 'BOOT_FAILED', message: error.message, stage: stageName };
      this.recoveryMode = true;
      this.state = 'recovery';
      await this.recovery.enter(error, { stage: stageName, kernel: this.kernel });
      const recoveryResult = await this.recovery.recoverKernel(this.kernel);
      this.finishedAt = this.clock();
      await this.#log('error', 'Boot entered recovery mode.', { eventCode: 'BOOT_RECOVERY', error: this.error, recoveryResult });
      this.events.emit('boot.failed', this.status());
      return this.status();
    }
  }

  async shutdown({ reason = 'requested' } = {}) {
    if (this.state === 'shutdown') return this.status();
    const result = await this.kernel?.shutdown({ reason });
    this.state = 'shutdown';
    this.finishedAt = this.clock();
    await this.#log('info', 'Boot manager stopped the system.', { eventCode: 'BOOT_SHUTDOWN', reason });
    this.events.emit('boot.shutdown', { reason, result });
    return this.status();
  }

  async reboot() {
    await this.shutdown({ reason: 'reboot' });
    this.kernel = null;
    this.state = 'cold';
    this.stageRecords = [];
    this.error = null;
    this.finishedAt = null;
    this.recovery = new RecoveryManager({ store: this.store, logger: this.logger, events: this.events });
    this.recoveryMode = false;
    this.configError = null;
    return this.boot();
  }

  status() {
    return {
      state: this.state, bootId: this.bootId, recoveryMode: this.recoveryMode,
      startedAt: this.startedAt === null ? null : new Date(this.startedAt).toISOString(),
      finishedAt: this.finishedAt === null ? null : new Date(this.finishedAt).toISOString(),
      durationMs: this.startedAt === null ? 0 : (this.finishedAt || this.clock()) - this.startedAt,
      stages: this.stageRecords.map(record => ({ ...record, dependencies: [...record.dependencies] })),
      error: this.error, recovery: this.recovery.status(), kernel: this.kernel?.status() || null
    };
  }

  #progress(record) {
    const detail = { bootId: this.bootId, state: this.state, stage: record.stage, stageState: record.state, attempt: record.attempts, timestamp: new Date(this.clock()).toISOString(), dependencies: record.dependencies };
    this.events.emit('boot.progress', detail);
    if (record.state === 'running') record.startedAt = this.clock();
  }

  async #runStage(stage, overallDeadline) {
    const record = this.stageRecords.find(item => item.stage === stage);
    record.state = 'running';
    this.#progress(record);
    if (stage === 'configuration') {
      try { validateBootConfig(this.config); }
      catch (error) {
        this.configError ||= error;
        this.config = structuredCloneSafe(DEFAULT_BOOT_CONFIG);
        this.recoveryMode = true;
        await this.recovery.enter(error, { stage: 'configuration' });
      }
      if (this.configError) {
        this.recoveryMode = true;
        await this.#log('warn', 'Using validated safe defaults after configuration warning.', { eventCode: 'BOOT_CONFIG_RECOVERED', error: this.configError.message });
      }
      if (typeof this.createKernel !== 'function') throw new NumiOSError('KERNEL_FACTORY_MISSING', 'Boot manager requires a kernel factory.');
      this.kernel = this.createKernel({ recoveryMode: this.recoveryMode, bootConfig: this.config, bootId: this.bootId });
      if (!this.kernel) throw new NumiOSError('KERNEL_INIT_FAILED', 'Kernel factory returned no kernel.');
      this.kernel.rebootHandler = () => this.reboot();
      return { configVersion: this.config.schemaVersion, recoveryMode: this.recoveryMode, configError: this.configError?.message || null };
    }
    const remaining = overallDeadline - this.clock();
    if (remaining <= 0) throw new NumiOSError('BOOT_TIMEOUT', 'Overall boot timeout was exceeded.', { stage });
    const stageTimeout = Math.min(this.config?.stageTimeoutMs || 15000, remaining);
    const action = async () => {
      switch (stage) {
        case 'storage': await this.store?.ready?.(); return this.kernel.initializeStorage();
        case 'kernel': return this.kernel.initializeCore();
        case 'syscalls': return this.kernel.registerSyscalls();
        case 'security': return this.kernel.initializeSecurity();
        case 'processes': return this.kernel.initializeProcesses();
        case 'filesystems': return this.kernel.mountFilesystems();
        case 'services': return this.kernel.startServices();
        case 'target': return this.kernel.executeTarget(this.recoveryMode ? (this.config.recovery?.safeTarget || 'recovery.target') : (this.config.serviceTarget || 'default.target'));
        case 'ready': return this.kernel.markReady({ bootId: this.bootId, recoveryMode: this.recoveryMode, stages: this.stageRecords.map(item => item.stage) });
        default: throw new NumiOSError('BOOT_STAGE_UNKNOWN', 'Unknown boot stage.', { stage });
      }
    };
    const result = await timeout(action(), stageTimeout, stage);
    return result;
  }

  async #log(level, message, metadata) {
    if (!this.logger) return;
    await this.logger.log(level, 'boot', message, metadata, 'boot-manager');
  }
}

function timeout(promise, timeoutMs, stage) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new NumiOSError('BOOT_STAGE_TIMEOUT', `Boot stage '${stage}' exceeded ${timeoutMs}ms.`, { stage, timeoutMs })), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}
function structuredCloneSafe(value) { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
