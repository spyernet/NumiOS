import { NumiOSError } from '../core/errors.js';

export class RecoveryManager {
  constructor({ store = null, logger = null, events = null } = {}) {
    this.store = store;
    this.logger = logger;
    this.events = events;
    this.active = false;
    this.reason = null;
    this.failures = [];
    this.enteredAt = null;
  }

  async enter(error, { stage = null, kernel = null } = {}) {
    this.active = true;
    this.reason = { code: error?.code || 'BOOT_FAILURE', message: error?.message || String(error), stage };
    this.failures.push({ ...this.reason, timestamp: new Date().toISOString() });
    this.enteredAt ||= new Date().toISOString();
    if (kernel) kernel.recoveryMode = true;
    await this.logger?.error('boot.recovery', 'Recovery mode entered.', { eventCode: 'RECOVERY_ENTERED', ...this.reason });
    await this.store?.set?.('lifecycle/recovery', { active: true, enteredAt: this.enteredAt, reason: this.reason, failures: this.failures });
    this.events?.emit('boot.recovery', { active: true, reason: this.reason });
    return this.status();
  }

  async recoverKernel(kernel) {
    const actions = [];
    if (!kernel) return { recovered: false, actions, error: { code: 'KERNEL_UNAVAILABLE', message: 'Kernel core could not be initialized.' } };
    try {
      if (kernel.packageManager) actions.push({ action: 'package-journal-recovery', result: await kernel.packageManager.recover() });
      if (kernel.diagnostics) actions.push({ action: 'diagnostics', result: await kernel.diagnostics.run() });
      if (kernel.state === 'ready' && kernel.recoveryMode) actions.push({ action: 'safe-target', result: { target: kernel.activeTarget } });
      return { recovered: true, actions };
    } catch (error) {
      await this.enter(error, { stage: 'recovery', kernel });
      return { recovered: false, actions, error: { code: error.code || 'RECOVERY_FAILED', message: error.message } };
    }
  }

  async clear() {
    this.active = false;
    this.reason = null;
    await this.store?.set?.('lifecycle/recovery', { active: false, clearedAt: new Date().toISOString(), failures: this.failures });
    this.events?.emit('boot.recovery', { active: false });
    return this.status();
  }

  status() { return { active: this.active, reason: this.reason, enteredAt: this.enteredAt, failures: [...this.failures] }; }
}

export function validateBootConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new NumiOSError('BOOT_CONFIG_INVALID', 'Boot configuration must be a JSON object.');
  if (config.schemaVersion !== 1) throw new NumiOSError('BOOT_CONFIG_VERSION_UNSUPPORTED', 'Only boot config schema version 1 is supported.');
  if (!Array.isArray(config.stages) || config.stages.length === 0) throw new NumiOSError('BOOT_CONFIG_INVALID', 'Boot configuration must declare an ordered stage list.');
  const requiredStages = ['configuration', 'storage', 'kernel', 'syscalls', 'security', 'processes', 'filesystems', 'services', 'target', 'ready'];
  if (requiredStages.some((stage, index) => config.stages[index] !== stage) || config.stages.length !== requiredStages.length) throw new NumiOSError('BOOT_CONFIG_INVALID', 'Boot stages must follow the deterministic NumiOS startup order.', { requiredStages });
  for (const key of ['timeoutMs', 'stageTimeoutMs']) if (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > 300000) throw new NumiOSError('BOOT_CONFIG_INVALID', `${key} must be between 1 and 300000 milliseconds.`);
  if (!config.recovery || typeof config.recovery.enabled !== 'boolean' || typeof config.recovery.safeTarget !== 'string') throw new NumiOSError('BOOT_CONFIG_INVALID', 'Recovery settings are invalid.');
  if (config.serviceUnits !== undefined && (!Array.isArray(config.serviceUnits) || config.serviceUnits.some(path => typeof path !== 'string'))) throw new NumiOSError('BOOT_CONFIG_INVALID', 'serviceUnits must be an array of URL strings.');
  return true;
}
