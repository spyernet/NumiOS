export class Diagnostics {
  constructor({ getKernelStatus, vfs, diskManager, serviceManager, packageManager, quotas, dispatcher, processManager, logger } = {}) {
    this.getKernelStatus = getKernelStatus;
    this.vfs = vfs;
    this.diskManager = diskManager;
    this.serviceManager = serviceManager;
    this.packageManager = packageManager;
    this.quotas = quotas;
    this.dispatcher = dispatcher;
    this.processManager = processManager;
    this.logger = logger;
    this.lastReport = null;
  }

  async run() {
    const checks = [];
    checks.push(await this.#check('kernel', async () => {
      const status = this.getKernelStatus();
      return { healthy: status.state === 'ready', state: status.state, version: status.version };
    }));
    checks.push(await this.#check('mounts', async () => {
      const mounts = this.vfs.mounts();
      const root = mounts.find(mount => mount.mountPoint === '/');
      return { healthy: Boolean(root), rootMountId: root?.id || null, count: mounts.length };
    }));
    checks.push(await this.#check('storage', async () => this.diskManager.diagnostics()));
    checks.push(await this.#check('quotas', async () => this.quotas.checkHealth()));
    checks.push(await this.#check('services', async () => {
      const services = this.serviceManager.list();
      const failed = services.filter(service => service.enabled && service.state === 'failed');
      return { healthy: failed.length === 0, total: services.length, failed: failed.map(service => service.name) };
    }));
    checks.push(await this.#check('packages', async () => this.packageManager.verifyInstalled()));
    checks.push(await this.#check('processes', async () => {
      const list = this.processManager.list();
      return { healthy: true, active: list.filter(item => !['terminated', 'failed'].includes(item.state)).length, failed: list.filter(item => item.state === 'failed').length };
    }));
    checks.push(await this.#check('syscalls', async () => {
      const status = this.dispatcher.status();
      return { healthy: status.initialized, registered: status.count, failures: status.failures };
    }));
    const failed = checks.filter(check => !check.healthy);
    this.lastReport = { timestamp: new Date().toISOString(), healthy: failed.length === 0, checks };
    await this.logger?.info('diagnostics', 'Health diagnostics completed.', { eventCode: 'DIAGNOSTICS_COMPLETE', healthy: this.lastReport.healthy, failed: failed.map(check => check.name) });
    return structuredCloneSafe(this.lastReport);
  }

  #check(name, callback) {
    return Promise.resolve().then(callback).then(data => ({ name, healthy: data?.healthy !== false, data })).catch(error => ({ name, healthy: false, error: { code: error.code || 'DIAGNOSTIC_FAILED', message: error.message } }));
  }

  get health() { return this.lastReport ? structuredCloneSafe(this.lastReport) : { timestamp: null, healthy: false, checks: [] }; }
}
function structuredCloneSafe(value) { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
