import { NumiOSError } from '../core/errors.js';
import { sha256 } from '../packages/verifier.js';

export class ApplicationLoader {
  constructor({ packageManager, processManager, security, workerRuntime, logger = null, syscallHost = null } = {}) {
    this.packageManager = packageManager;
    this.processManager = processManager;
    this.security = security;
    this.workerRuntime = workerRuntime;
    this.logger = logger;
    this.syscallHost = syscallHost;
    this.launches = new Map();
  }

  async launch(id, { args = [], env = {}, identity = 'system', priority = 0 } = {}) {
    const callerId = typeof identity === 'string' ? identity : identity.id;
    const caller = this.security.resolve(callerId);
    this.security.assertCapability(caller, 'process.spawn');
    const packageRecord = await this.packageManager.get(id);
    if (!packageRecord || packageRecord.type !== 'application') throw new NumiOSError('APP_NOT_FOUND', 'Application package is not installed.', { id });
    await this.#verifyInstalledFiles(packageRecord);
    const capabilities = this.security.grantApplicationCapabilities(id, packageRecord.capabilities || []);
    const process = this.processManager.create({
      caller: callerId,
      parentPid: caller.processId ?? undefined,
      uid: env.USER || 'demo',
      name: packageRecord.name,
      type: 'application',
      packageId: id,
      args,
      env: { ...env, NUMIOS_APP_ID: id },
      capabilities,
      priority,
      metadata: { version: packageRecord.version, entry: packageRecord.entry }
    });
    this.launches.set(process.pid, { id, startedAt: new Date().toISOString() });
    try {
      await this.workerRuntime.launchApplication({ pid: process.pid, packageRecord, args, env: process.env });
      await this.logger?.info('runtime', 'Application launched in isolated Worker.', { eventCode: 'APP_LAUNCHED', id, pid: process.pid, version: packageRecord.version }, `pid:${process.pid}`);
      return { pid: process.pid, id, state: 'running', mode: 'worker' };
    } catch (error) {
      await this.processManager.exit(process.pid, { failed: true, exitCode: 1, error });
      this.launches.delete(process.pid);
      throw error;
    }
  }

  async terminate(pid, { identity = 'system' } = {}) {
    const caller = typeof identity === 'string' ? identity : identity.id;
    const process = await this.processManager.terminate(pid, { caller });
    this.launches.delete(pid);
    return process;
  }

  status(id) {
    const active = this.processManager.list({ type: 'application' }).filter(process => process.packageId === id);
    return active.length ? active.map(process => ({ pid: process.pid, state: process.state, startedAt: process.startedAt })) : 'stopped';
  }

  list() {
    return this.processManager.list({ type: 'application' }).map(process => ({ pid: process.pid, id: process.packageId, name: process.name, state: process.state, startedAt: process.startedAt }));
  }

  async recover() {
    for (const process of this.processManager.list({ type: 'application' })) {
      if (process.state === 'running' && !this.launches.has(process.pid)) await this.processManager.terminate(process.pid, { caller: 'system', exitCode: 0 });
    }
    return { restored: false, reason: 'Browser Workers cannot be resumed after page reload; persisted OS state is restored and applications must be launched again.' };
  }

  async #verifyInstalledFiles(record) {
    for (const [path, metadata] of Object.entries(record.files || {})) {
      const bytes = await this.packageManager.store.get(`packages/files/${record.id}/${path}`);
      if (!bytes) throw new NumiOSError('PACKAGE_FILE_MISSING', 'Installed application file is missing.', { id: record.id, path });
      if (await sha256(bytes) !== metadata.sha256) throw new NumiOSError('PACKAGE_HASH_MISMATCH', 'Installed application file failed integrity verification.', { id: record.id, path });
      const virtualPath = `${record.installPath}/${path}`;
      const vfsBytes = await this.packageManager.vfs.readFile(virtualPath);
      if (await sha256(vfsBytes) !== metadata.sha256) throw new NumiOSError('PACKAGE_FILESYSTEM_MISMATCH', 'VFS application file does not match the verified package record.', { id: record.id, path });
    }
  }
}
