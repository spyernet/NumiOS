import { createId } from '../core/ids.js';
import { NumiOSError } from '../core/errors.js';
import { parseJson } from '../core/schema.js';
import { normalizePath } from '../fs/path.js';
import { verifyNppArchive, sha256 } from './verifier.js';
import { parseVersion, satisfiesVersion, compareVersions } from './semver.js';

export class PackageManager {
  constructor({ store, vfs, repositoryManager, security, coordinator = null, logger = null, policy = {}, osVersion = '0.1.0', applicationLoader = null } = {}) {
    if (!store || !vfs) throw new NumiOSError('INVALID_ARGUMENT', 'PackageManager requires storage and VFS.');
    this.store = store;
    this.vfs = vfs;
    this.repositoryManager = repositoryManager;
    this.security = security;
    this.coordinator = coordinator;
    this.logger = logger;
    this.policy = policy;
    this.osVersion = osVersion;
    this.applicationLoader = applicationLoader;
  }

  async recover() {
    const journals = await this.store.list('packages/journal/');
    const recovered = [];
    for (const [key, journal] of journals) {
      try {
        if (journal.operation === 'install') await this.#recoverInstall(journal);
        else if (journal.operation === 'remove') await this.#recoverRemove(journal);
        else throw new NumiOSError('PACKAGE_JOURNAL_INVALID', 'Unknown package transaction journal operation.', { key });
        recovered.push({ transactionId: journal.transactionId, operation: journal.operation, recovered: true });
      } catch (error) {
        await this.logger?.error('package', 'Package recovery failed.', { eventCode: 'PACKAGE_RECOVERY_FAILED', key, error: error.message });
        throw new NumiOSError('PACKAGE_RECOVERY_FAILED', 'Package transaction recovery failed; package operations are disabled until repaired.', { key, cause: error.message });
      }
    }
    return recovered;
  }

  async install({ archive = null, source = 'local', repositoryId = null, packageId = null, range = '*', allowUnsignedLocal = false, identity = 'system', signal } = {}) {
    this.#assertCapability(identity, 'package.install');
    return this.#withLock(async () => {
      let verified;
      let archiveBytes;
      let selectedRepository = repositoryId;
      if (source === 'repository') {
        if (!packageId || !this.repositoryManager) throw new NumiOSError('INVALID_ARGUMENT', 'Repository install requires packageId and a repository manager.');
        const selection = await this.repositoryManager.query(packageId, { range, signal });
        if (!selection || (repositoryId && selection.repositoryId !== repositoryId)) throw new NumiOSError('PACKAGE_NOT_FOUND', 'No matching package release was found.', { packageId, range, repositoryId });
        selectedRepository = selection.repositoryId;
        const repoConfig = this.repositoryManager.config.repositories.find(item => item.id === selectedRepository);
        const requireSignature = this.#requiresSignature(selection, repoConfig);
        const downloaded = await this.repositoryManager.download(selection, { signal, requireSignature });
        verified = downloaded;
        archiveBytes = downloaded.archiveBytes;
      } else if (source === 'local') {
        archiveBytes = normalizeArchive(archive);
        if (archiveBytes.byteLength > (this.policy.maximumArchiveBytes || 32 * 1024 * 1024)) throw new NumiOSError('PACKAGE_TOO_LARGE', 'NPP archive exceeds system policy.');
        const allowUnsigned = Boolean(allowUnsignedLocal && this.policy.allowUnsignedLocal);
        verified = await verifyNppArchive(archiveBytes, {
          osVersion: this.osVersion,
          trustedKeys: this.policy.trustedKeys || {},
          requireSignature: false,
          allowUnsigned,
          maxArchiveBytes: this.policy.maximumArchiveBytes || 32 * 1024 * 1024,
          maxUnpackedBytes: this.policy.maximumUnpackedBytes || 64 * 1024 * 1024
        });
      } else throw new NumiOSError('INVALID_ARGUMENT', 'Package source must be local or repository.');

      if (packageId && verified.manifest.id !== packageId) throw new NumiOSError('PACKAGE_ID_MISMATCH', 'Package archive id does not match the requested id.', { expected: packageId, actual: verified.manifest.id });
      const plan = await this.#dependencyPlan(verified.manifest, signal);
      const installedBefore = new Set((await this.list()).map(record => record.id));
      const installedDependencies = [];
      try {
        for (const dependency of plan) {
          const record = await this.#installVerified(dependency, { source: 'dependency', repositoryId: dependency.repositoryId, signal });
          if (!installedBefore.has(record.id)) installedDependencies.push(record.id);
        }
        return await this.#installVerified({ ...verified, archiveBytes }, { source, repositoryId: selectedRepository, signal });
      } catch (error) {
        const rollbackErrors = [];
        for (const dependencyId of installedDependencies.reverse()) {
          try { await this.#removeUnlocked(dependencyId, { cascade: false, identity, signal }); }
          catch (rollbackError) { rollbackErrors.push({ id: dependencyId, message: rollbackError.message }); }
        }
        if (rollbackErrors.length) throw new NumiOSError('PACKAGE_ROLLBACK_FAILED', 'Package installation failed and one or more newly installed dependencies could not be removed.', { cause: error.message, rollbackErrors });
        throw error;
      }
    }, signal);
  }

  async #dependencyPlan(manifest, signal) {
    const planned = new Map();
    const visiting = [];
    const ordered = [];
    const visit = async current => {
      if (visiting.includes(current.id)) throw new NumiOSError('PACKAGE_DEPENDENCY_CYCLE', 'Package dependency cycle detected.', { cycle: [...visiting, current.id] });
      visiting.push(current.id);
      for (const [dependencyId, range] of Object.entries(current.dependencies || {})) {
        const installed = await this.get(dependencyId);
        if (installed && satisfiesVersion(installed.version, range)) continue;
        if (installed) throw new NumiOSError('PACKAGE_DEPENDENCY_CONFLICT', 'Installed dependency version does not satisfy the package requirement; update it explicitly first.', { packageId: dependencyId, installed: installed.version, required: range });
        const existingPlan = planned.get(dependencyId);
        if (existingPlan) {
          if (!satisfiesVersion(existingPlan.manifest.version, range)) throw new NumiOSError('PACKAGE_DEPENDENCY_CONFLICT', 'Dependency requirements cannot be resolved to one version.', { packageId: dependencyId, range, selected: existingPlan.manifest.version });
          continue;
        }
        if (!this.repositoryManager) throw new NumiOSError('PACKAGE_DEPENDENCY_MISSING', 'Package dependency is not installed and no repository manager is available.', { packageId: dependencyId, range });
        const selection = await this.repositoryManager.query(dependencyId, { range, signal });
        if (!selection) throw new NumiOSError('PACKAGE_DEPENDENCY_MISSING', 'No compatible package dependency release was found.', { packageId: dependencyId, range });
        const repoConfig = this.repositoryManager.config.repositories.find(item => item.id === selection.repositoryId);
        const requireSignature = this.#requiresSignature(selection, repoConfig);
        const downloaded = await this.repositoryManager.download(selection, { signal, requireSignature });
        if (!satisfiesVersion(downloaded.manifest.version, range)) throw new NumiOSError('PACKAGE_DEPENDENCY_CONFLICT', 'Repository returned an incompatible dependency version.', { packageId: dependencyId, range, version: downloaded.manifest.version });
        planned.set(dependencyId, { ...downloaded, repositoryId: selection.repositoryId });
        await visit(downloaded.manifest);
        ordered.push({ ...downloaded, repositoryId: selection.repositoryId });
      }
      visiting.pop();
    };
    await visit(manifest);
    return ordered;
  }

  async #installVerified(verified, { source, repositoryId = null, signal } = {}) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    const manifest = verified.manifest;
    const existing = await this.get(manifest.id);
    if (existing && existing.version === manifest.version) return { ...existing, unchanged: true };
    if (existing && compareVersions(manifest.version, existing.version) < 0) throw new NumiOSError('PACKAGE_DOWNGRADE_DENIED', 'Package downgrade requires a separately approved policy.');
    await this.#assertExistingDependencies(manifest);
    const root = manifest.type === 'application' ? '/Apps' : '/Library';
    const target = `${root}/${manifest.id}`;
    const transactionId = createId('pkg-tx');
    const stage = `${root}/.numios-stage-${transactionId}`;
    const backup = `${root}/.numios-backup-${transactionId}`;
    const journal = {
      operation: 'install', transactionId, id: manifest.id, version: manifest.version, target, stage, backup,
      hadOld: Boolean(existing), oldVersion: existing?.version || null, createdAt: new Date().toISOString(), phase: 'prepared'
    };
    await this.store.set(`packages/journal/${transactionId}`, journal);
    try {
      await this.vfs.mkdir(stage, { recursive: false, mode: 0o755 });
      for (const [path, data] of verified.files) {
        if (path === 'manifest.json') continue;
        const destination = `${stage}/${path}`;
        const parent = destination.slice(0, destination.lastIndexOf('/'));
        await this.vfs.mkdir(parent, { recursive: true, mode: 0o755 });
        if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
        await this.vfs.writeFile(destination, data, { create: true, mode: 0o644, owner: 'system' });
      }
      journal.phase = 'staged';
      await this.store.set(`packages/journal/${transactionId}`, journal);
      if (existing) {
        if (await exists(this.vfs, target)) await this.vfs.rename(target, backup);
        journal.phase = 'backed-up';
        await this.store.set(`packages/journal/${transactionId}`, journal);
      }
      await this.vfs.rename(stage, target);
      journal.phase = 'published';
      await this.store.set(`packages/journal/${transactionId}`, journal);

      const packageRecord = {
        id: manifest.id, name: manifest.name, version: manifest.version, type: manifest.type,
        entry: manifest.entry, runtime: manifest.runtime, minimumOSVersion: manifest.minimumOSVersion,
        dependencies: { ...manifest.dependencies }, capabilities: [...manifest.capabilities], files: { ...manifest.files },
        signature: verified.signature, source, repositoryId, installPath: target, installedAt: new Date().toISOString(), transactionId
      };
      const oldFileKeys = await this.store.list(`packages/files/${manifest.id}/`);
      const allowedFileKeys = new Set(Object.keys(manifest.files).map(path => `packages/files/${manifest.id}/${path}`));
      const operations = [
        { type: 'set', key: `packages/db/${manifest.id}`, value: packageRecord },
        { type: 'set', key: `packages/journal/${transactionId}`, value: { ...journal, phase: 'committed' } }
      ];
      for (const [path, data] of verified.files) if (path !== 'manifest.json') operations.push({ type: 'set', key: `packages/files/${manifest.id}/${path}`, value: data });
      for (const [key] of oldFileKeys) if (!allowedFileKeys.has(key)) operations.push({ type: 'delete', key });
      await this.store.batch(operations);
      if (existing && await exists(this.vfs, backup)) await this.vfs.unlink(backup, { recursive: true });
      await this.store.delete(`packages/journal/${transactionId}`);
      await this.logger?.info('package', 'Package installed.', { eventCode: 'PACKAGE_INSTALLED', id: manifest.id, version: manifest.version, source, repositoryId });
      return packageRecord;
    } catch (error) {
      try { await this.#recoverInstall(journal); }
      catch (recoveryError) { throw new NumiOSError('PACKAGE_ROLLBACK_FAILED', 'Package installation failed and rollback also failed.', { cause: error.message, rollback: recoveryError.message, transactionId }); }
      throw error;
    }
  }

  async #recoverInstall(journal) {
    const current = await this.get(journal.id);
    if (current?.transactionId === journal.transactionId) {
      if (await exists(this.vfs, journal.backup)) await this.vfs.unlink(journal.backup, { recursive: true });
      if (await exists(this.vfs, journal.stage)) await this.vfs.unlink(journal.stage, { recursive: true });
      await this.store.delete(`packages/journal/${journal.transactionId}`);
      return;
    }
    const backupExists = await exists(this.vfs, journal.backup);
    if (journal.hadOld && backupExists) {
      if (await exists(this.vfs, journal.target)) await this.vfs.unlink(journal.target, { recursive: true });
      await this.vfs.rename(journal.backup, journal.target);
    } else if (!journal.hadOld && await exists(this.vfs, journal.target)) {
      await this.vfs.unlink(journal.target, { recursive: true });
    }
    if (await exists(this.vfs, journal.stage)) await this.vfs.unlink(journal.stage, { recursive: true });
    await this.store.delete(`packages/journal/${journal.transactionId}`);
  }

  async remove(id, { cascade = false, identity = 'system', signal } = {}) {
    this.#assertCapability(identity, 'package.remove');
    return this.#withLock(() => this.#removeUnlocked(id, { cascade, identity, signal }), signal);
  }

  async #removeUnlocked(id, { cascade, identity, signal, visited = new Set() }) {
    if (visited.has(id)) {
      if (!(await this.get(id))) return { removed: [] };
      throw new NumiOSError('PACKAGE_DEPENDENCY_CYCLE', 'Installed package dependency cycle encountered during removal.', { id });
    }
    visited.add(id);
    const installed = await this.get(id);
    if (!installed) throw new NumiOSError('PACKAGE_NOT_FOUND', 'Package is not installed.', { id });
    const dependents = [];
    for (const record of await this.list()) if (record.id !== id && Object.hasOwn(record.dependencies, id)) dependents.push(record.id);
    if (dependents.length && !cascade) throw new NumiOSError('PACKAGE_HAS_DEPENDENTS', 'Package is required by installed packages.', { id, dependents });
    const removed = [];
    for (const dependent of dependents) removed.push(...(await this.#removeUnlocked(dependent, { cascade: true, identity, signal, visited })).removed);
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    const txId = createId('pkg-remove');
    const packageParent = installed.installPath.slice(0, installed.installPath.lastIndexOf('/'));
    const backup = `${packageParent}/.numios-remove-${txId}`;
    const journal = { operation: 'remove', transactionId: txId, id, path: installed.installPath, backup, createdAt: new Date().toISOString() };
    await this.store.set(`packages/journal/${txId}`, journal);
    try {
      if (await exists(this.vfs, installed.installPath)) await this.vfs.rename(installed.installPath, backup);
      journal.phase = 'backed-up';
      await this.store.set(`packages/journal/${txId}`, journal);
      const fileKeys = await this.store.list(`packages/files/${id}/`);
      await this.store.batch([
        { type: 'delete', key: `packages/db/${id}` },
        ...fileKeys.map(([key]) => ({ type: 'delete', key })),
        { type: 'set', key: `packages/journal/${txId}`, value: { ...journal, phase: 'committed' } }
      ]);
      if (await exists(this.vfs, backup)) await this.vfs.unlink(backup, { recursive: true });
      await this.store.delete(`packages/journal/${txId}`);
      await this.logger?.info('package', 'Package removed.', { eventCode: 'PACKAGE_REMOVED', id, version: installed.version });
      removed.push(id);
      return { removed };
    } catch (error) {
      await this.#recoverRemove(journal);
      throw error;
    }
  }

  async #recoverRemove(journal) {
    const installed = await this.get(journal.id);
    if (installed) {
      if (await exists(this.vfs, journal.backup)) {
        if (await exists(this.vfs, journal.path)) await this.vfs.unlink(journal.path, { recursive: true });
        await this.vfs.rename(journal.backup, journal.path);
      }
      await this.store.delete(`packages/journal/${journal.transactionId}`);
      return;
    }
    if (await exists(this.vfs, journal.backup)) await this.vfs.unlink(journal.backup, { recursive: true });
    await this.store.delete(`packages/journal/${journal.transactionId}`);
  }

  async update(id = null, { identity = 'system', signal } = {}) {
    this.#assertCapability(identity, 'package.install');
    const installed = id ? [await this.get(id)].filter(Boolean) : await this.list();
    const updates = [];
    for (const record of installed) {
      const versions = await this.repositoryManager?.versions(record.id, { signal }) || [];
      const newer = versions.filter(item => compareVersions(item.version, record.version) > 0).sort((a, b) => compareVersions(b.version, a.version))[0];
      if (!newer) continue;
      const selection = await this.repositoryManager.query(record.id, { range: `>${record.version}`, signal });
      if (!selection) continue;
      const repoConfig = this.repositoryManager.config.repositories.find(item => item.id === selection.repositoryId);
      const downloaded = await this.repositoryManager.download(selection, { signal, requireSignature: selection.local ? !this.policy.allowUnsignedLocal : Boolean(repoConfig && (repoConfig.trustPolicy || 'signed') === 'signed') });
      const dependencyPlan = await this.#dependencyPlan(downloaded.manifest, signal);
      const result = await this.#withLock(async () => {
        const installedBefore = new Set((await this.list()).map(item => item.id));
        const newlyInstalled = [];
        try {
          for (const dependency of dependencyPlan) {
            const dependencyRecord = await this.#installVerified(dependency, { source: 'dependency', repositoryId: dependency.repositoryId, signal });
            if (!installedBefore.has(dependencyRecord.id)) newlyInstalled.push(dependencyRecord.id);
          }
          return await this.#installVerified({ ...downloaded, archiveBytes: downloaded.archiveBytes }, { source: 'repository', repositoryId: selection.repositoryId, signal });
        } catch (error) {
          const rollbackErrors = [];
          for (const dependencyId of newlyInstalled.reverse()) {
            try { await this.#removeUnlocked(dependencyId, { cascade: false, identity, signal }); }
            catch (rollbackError) { rollbackErrors.push({ id: dependencyId, message: rollbackError.message }); }
          }
          if (rollbackErrors.length) throw new NumiOSError('PACKAGE_ROLLBACK_FAILED', 'Update failed and dependency rollback was incomplete.', { cause: error.message, rollbackErrors });
          throw error;
        }
      }, signal);
      updates.push({ id: record.id, from: record.version, to: result.version });
    }
    return { updates };
  }

  async query(id) { return this.get(id); }
  async get(id) { return this.store.get(`packages/db/${id}`); }
  async list({ type = null } = {}) {
    const records = (await this.store.list('packages/db/')).map(([, value]) => value).filter(Boolean);
    return records.filter(record => !type || record.type === type).sort((a, b) => a.id.localeCompare(b.id));
  }

  async planUpdate(id) {
    const installed = id ? [await this.get(id)].filter(Boolean) : await this.list();
    const plan = [];
    for (const record of installed) {
      const available = await this.repositoryManager?.versions(record.id) || [];
      const candidate = available.filter(item => compareVersions(item.version, record.version) > 0).sort((a, b) => compareVersions(b.version, a.version))[0];
      if (candidate) plan.push({ id: record.id, from: record.version, to: candidate.version, repositoryId: candidate.repositoryId });
    }
    return plan;
  }

  async verifyInstalled() {
    const failures = [];
    const records = await this.list();
    for (const record of records) {
      for (const [path, metadata] of Object.entries(record.files || {})) {
        const bytes = await this.store.get(`packages/files/${record.id}/${path}`);
        if (!bytes) { failures.push({ id: record.id, path, code: 'PACKAGE_FILE_MISSING' }); continue; }
        if (await sha256(bytes) !== metadata.sha256) failures.push({ id: record.id, path, code: 'PACKAGE_HASH_MISMATCH' });
      }
    }
    return { healthy: failures.length === 0, packages: records.length, failures };
  }

  async launch(id, { args = [], env = {}, identity = 'system', priority = 0 } = {}) {
    if (!this.applicationLoader) throw new NumiOSError('APP_RUNTIME_UNAVAILABLE', 'Application loader is not initialized.');
    return this.applicationLoader.launch(id, { args, env, identity, priority });
  }

  async terminateApp(pid, options = {}) { return this.applicationLoader?.terminate(pid, options); }
  async applications() { return (await this.list({ type: 'application' })).map(record => ({ id: record.id, name: record.name, version: record.version, state: this.applicationLoader?.status(record.id) || 'stopped' })); }

  #requiresSignature(selection, repository) {
    if (selection.local) return !this.policy.allowUnsignedLocal;
    if (!repository || repository.trustPolicy !== 'unsigned') return true;
    return !this.repositoryManager?.trustedRepositoryIds?.has(repository.id);
  }

  async #assertExistingDependencies(manifest) {
    const installed = await this.list();
    for (const record of installed) {
      if (record.id === manifest.id) continue;
      const range = record.dependencies?.[manifest.id];
      if (range && !satisfiesVersion(manifest.version, range)) throw new NumiOSError('PACKAGE_DEPENDENCY_CONFLICT', 'New package version would break an installed package dependency.', { packageId: manifest.id, dependent: record.id, required: range, actual: manifest.version });
    }
  }

  #assertCapability(identity, capability) {
    if (!this.security) return;
    const principal = this.security.resolve(typeof identity === 'string' ? identity : identity?.id);
    this.security.assertCapability(principal, capability);
  }

  async #withLock(callback, signal) {
    if (this.coordinator) return this.coordinator.withLock('package-manager', callback, { signal });
    return callback();
  }
}

async function exists(vfs, path) {
  try { await vfs.stat(path); return true; }
  catch (error) { if (error.code === 'NOT_FOUND') return false; throw error; }
}
function normalizeArchive(archive) {
  if (archive instanceof Uint8Array) return archive;
  if (archive instanceof ArrayBuffer) return new Uint8Array(archive);
  if (ArrayBuffer.isView(archive)) return new Uint8Array(archive.buffer, archive.byteOffset, archive.byteLength);
  throw new NumiOSError('INVALID_ARGUMENT', 'Local installation requires an NPP archive as bytes.');
}
function structuredCloneSafe(value) { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
