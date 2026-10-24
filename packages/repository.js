import { NumiOSError } from '../core/errors.js';
import { parseJson } from '../core/schema.js';
import { parseVersion, highestSatisfying, compareVersions } from './semver.js';
import { sha256, verifyNppArchive } from './verifier.js';

export class RepositoryManager {
  constructor({ config = { repositories: [] }, networkClient = null, store = null, logger = null, osVersion = '0.1.0', trustedKeys = {}, trustedRepositoryIds = [], maxArchiveBytes = 32 * 1024 * 1024, maxUnpackedBytes = 64 * 1024 * 1024 } = {}) {
    this.config = config;
    this.networkClient = networkClient;
    this.store = store;
    this.logger = logger;
    this.osVersion = osVersion;
    this.trustedKeys = trustedKeys;
    if (!Array.isArray(trustedRepositoryIds) || trustedRepositoryIds.some(id => typeof id !== 'string')) throw new NumiOSError('REPOSITORY_CONFIG_INVALID', 'Trusted repository ids must be a string array.');
    this.trustedRepositoryIds = new Set(trustedRepositoryIds);
    this.maxArchiveBytes = Number.isSafeInteger(maxArchiveBytes) && maxArchiveBytes > 0 ? maxArchiveBytes : 32 * 1024 * 1024;
    this.maxUnpackedBytes = Number.isSafeInteger(maxUnpackedBytes) && maxUnpackedBytes > 0 ? maxUnpackedBytes : 64 * 1024 * 1024;
    this.indexCache = new Map();
    this.localRepositories = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (!this.config || !Array.isArray(this.config.repositories)) throw new NumiOSError('REPOSITORY_CONFIG_INVALID', 'Repository configuration must include a repositories array.');
    const ids = new Set();
    for (const repository of this.config.repositories) {
      if (!repository || typeof repository.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(repository.id) || ids.has(repository.id)) throw new NumiOSError('REPOSITORY_CONFIG_INVALID', 'Repository id is invalid or duplicated.');
      ids.add(repository.id);
      if (repository.enabled && typeof repository.index !== 'string') throw new NumiOSError('REPOSITORY_CONFIG_INVALID', 'Enabled repository requires an index URL.', { id: repository.id });
      if (repository.enabled) validateIndexUrl(repository.index);
    }
    if (this.store) {
      const metadata = await this.store.list('repository/local-meta/');
      for (const [, entry] of metadata) {
        if (!entry || typeof entry.id !== 'string') continue;
        this.localRepositories.set(entry.id, { id: entry.id, name: entry.name || entry.id, packages: new Map() });
      }
      const archives = await this.store.list('repository/local/');
      for (const [key, archive] of archives) {
        const pieces = key.split('/');
        const repositoryId = pieces[2];
        if (pieces.length < 4) continue;
        const packageKey = pieces.slice(3).join('/');
        const separator = packageKey.lastIndexOf('@');
        if (separator < 1) continue;
        const repository = this.localRepositories.get(repositoryId);
        if (!repository) continue;
        try {
          const verified = await verifyNppArchive(archive, { osVersion: this.osVersion, trustedKeys: this.trustedKeys, allowUnsigned: true, maxArchiveBytes: this.maxArchiveBytes, maxUnpackedBytes: this.maxUnpackedBytes });
          repository.packages.set(`${verified.manifest.id}@${verified.manifest.version}`, { manifest: verified.manifest, archive, sha256: await sha256(archive) });
        } catch (error) {
          await this.logger?.warn('package.repository', 'Corrupt local repository entry was skipped.', { eventCode: 'LOCAL_REPOSITORY_ENTRY_INVALID', key, error: error.message });
        }
      }
    }
    this.initialized = true;
    return this;
  }

  list() {
    return [
      ...this.config.repositories.map(repository => ({ id: repository.id, name: repository.name, enabled: Boolean(repository.enabled), priority: repository.priority || 0, trustPolicy: repository.trustPolicy || 'signed', type: 'remote', index: repository.index })),
      ...[...this.localRepositories.values()].map(repository => ({ id: repository.id, name: repository.name, enabled: true, priority: 1000, trustPolicy: 'local-explicit', type: 'local', packageCount: repository.packages.size }))
    ].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  }

  async refresh(id = null, { signal } = {}) {
    await this.#ready();
    this.indexCache.clear();
    const refreshed = [];
    for (const repository of this.config.repositories.filter(item => item.enabled && (!id || item.id === id))) {
      const index = await this.#fetchIndex(repository, signal);
      refreshed.push({ id: repository.id, packageCount: Object.keys(index.packages).length });
    }
    return { refreshed };
  }

  async publishLocal(repositoryId, archive) {
    const repository = this.localRepositories.get(repositoryId);
    if (!repository) throw new NumiOSError('REPOSITORY_NOT_FOUND', 'Local repository is not registered.', { repositoryId });
    return this.#publishLocal(repository, archive);
  }

  async removeLocal(repositoryId, packageId, version) {
    const repository = this.localRepositories.get(repositoryId);
    if (!repository) throw new NumiOSError('REPOSITORY_NOT_FOUND', 'Local repository is not registered.', { repositoryId });
    return this.#removeLocal(repository, packageId, version);
  }

  async createLocalRepository({ id, name = id } = {}) {
    if (!this.store) throw new NumiOSError('STORAGE_UNAVAILABLE', 'A persistent store is required for a local repository.');
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new NumiOSError('INVALID_ARGUMENT', 'Local repository id is invalid.');
    if (this.localRepositories.has(id) || this.config.repositories.some(repo => repo.id === id)) throw new NumiOSError('ALREADY_EXISTS', 'Repository id is already registered.', { id });
    const repository = { id, name: String(name).slice(0, 160), packages: new Map() };
    await this.store.set(`repository/local-meta/${id}`, { id, name: repository.name });
    this.localRepositories.set(id, repository);
    return {
      id,
      publish: async archive => this.#publishLocal(repository, archive),
      remove: async (packageId, version) => this.#removeLocal(repository, packageId, version),
      list: () => [...repository.packages.entries()].map(([key, value]) => ({ key, manifest: value.manifest }))
    };
  }

  async query(packageId, { range = '*', signal } = {}) {
    await this.#ready();
    const results = [];
    for (const local of this.localRepositories.values()) {
      for (const release of local.packages.values()) if (release.manifest.id === packageId) results.push({ repositoryId: local.id, version: release.manifest.version, manifest: release.manifest, local: true });
    }
    const remoteRepos = this.config.repositories.filter(repository => repository.enabled).sort((a, b) => (b.priority || 0) - (a.priority || 0));
    for (const repository of remoteRepos) {
      const index = await this.#fetchIndex(repository, signal);
      const releases = index.packages[packageId] || [];
      for (const release of releases) results.push({ repositoryId: repository.id, version: release.version, release, local: false });
    }
    const version = highestSatisfying(results.map(item => item.version), range);
    if (!version) return null;
    return results.filter(item => item.version === version).sort((a, b) => this.#priority(b.repositoryId) - this.#priority(a.repositoryId))[0];
  }

  async versions(packageId, { signal } = {}) {
    await this.#ready();
    const results = [];
    for (const local of this.localRepositories.values()) for (const release of local.packages.values()) if (release.manifest.id === packageId) results.push({ repositoryId: local.id, version: release.manifest.version, local: true });
    for (const repository of this.config.repositories.filter(item => item.enabled)) {
      const index = await this.#fetchIndex(repository, signal);
      for (const release of index.packages[packageId] || []) results.push({ repositoryId: repository.id, version: release.version, local: false });
    }
    return results.sort((a, b) => this.#priority(b.repositoryId) - this.#priority(a.repositoryId) || -compareVersion(a.version, b.version));
  }

  async download(selection, { signal, requireSignature = false } = {}) {
    const localRepository = this.localRepositories.get(selection.repositoryId);
    let archive;
    let expectedHash;
    if (localRepository) {
      const release = localRepository.packages.get(`${selection.release?.id || selection.manifest?.id}@${selection.version}`)
        || [...localRepository.packages.values()].find(item => item.manifest.id === (selection.manifest?.id || selection.release?.id) && item.manifest.version === selection.version);
      if (!release) throw new NumiOSError('PACKAGE_NOT_FOUND', 'Local repository package is not present.');
      archive = release.archive;
      expectedHash = release.sha256;
    } else {
      const repository = this.config.repositories.find(item => item.id === selection.repositoryId && item.enabled);
      if (!repository) throw new NumiOSError('REPOSITORY_NOT_FOUND', 'Repository is not enabled.', { repositoryId: selection.repositoryId });
      const release = selection.release;
      if (!release?.url || !release.sha256) throw new NumiOSError('REPOSITORY_INDEX_INVALID', 'Selected repository release is incomplete.');
      const url = new URL(release.url, repository.index);
      if (url.origin !== new URL(repository.index).origin && repository.allowCrossOrigin !== true) throw new NumiOSError('REPOSITORY_URL_DENIED', 'Repository package URL must remain on the index origin.');
      const response = await this.networkClient.request({ url: url.href, method: 'GET', responseType: 'bytes', cache: 'no-store', signal });
      if (!response.ok) throw new NumiOSError('REPOSITORY_DOWNLOAD_FAILED', `Package download returned HTTP ${response.status}.`, { status: response.status });
      archive = response.body;
      expectedHash = release.sha256;
    }
    if (await sha256(archive) !== expectedHash) throw new NumiOSError('PACKAGE_HASH_MISMATCH', 'Repository archive SHA-256 does not match its index.');
    const verified = await verifyNppArchive(archive, { osVersion: this.osVersion, trustedKeys: this.trustedKeys, requireSignature, allowUnsigned: !requireSignature, maxArchiveBytes: this.maxArchiveBytes, maxUnpackedBytes: this.maxUnpackedBytes });
    if (selection.version && verified.manifest.version !== selection.version) throw new NumiOSError('REPOSITORY_VERSION_MISMATCH', 'Downloaded package version does not match selected index version.');
    return { ...verified, archiveBytes: archive };
  }

  async #fetchIndex(repository, signal) {
    const cached = this.indexCache.get(repository.id) || await this.store?.get?.(`repository/cache/${repository.id}`);
    if (cached && cached.expiresAt > Date.now()) { this.indexCache.set(repository.id, cached); return cached.index; }
    if (!this.networkClient) throw new NumiOSError('NETWORK_UNAVAILABLE', 'No browser network adapter is available for repositories.');
    let response;
    try { response = await this.networkClient.request({ url: repository.index, method: 'GET', cache: 'no-store', responseType: 'text', signal, timeoutMs: repository.timeoutMs || 15000 }); }
    catch (error) {
      if (error.code === 'NETWORK_CORS_OR_UNREACHABLE') throw new NumiOSError('REPOSITORY_CORS_OR_UNREACHABLE', 'Repository index could not be fetched; CORS or network policy may have blocked it.', { repositoryId: repository.id, cause: error.message });
      throw new NumiOSError('REPOSITORY_UNREACHABLE', 'Repository index is unreachable.', { repositoryId: repository.id, cause: error.message });
    }
    if (!response.ok) throw new NumiOSError('REPOSITORY_HTTP_ERROR', `Repository returned HTTP ${response.status}.`, { repositoryId: repository.id });
    let index;
    try { index = JSON.parse(response.body); } catch (error) { throw new NumiOSError('REPOSITORY_INDEX_INVALID', 'Repository index is not valid JSON.', { repositoryId: repository.id, cause: error.message }); }
    validateIndex(index, repository.id);
    const cacheRecord = { index, expiresAt: Date.now() + Math.min(300000, repository.cacheTtlMs || 60000) };
    this.indexCache.set(repository.id, cacheRecord);
    await this.store?.set?.(`repository/cache/${repository.id}`, cacheRecord);
    return index;
  }

  async #publishLocal(repository, archiveInput) {
    const archive = toBytes(archiveInput).slice();
    const verified = await verifyNppArchive(archive, { osVersion: this.osVersion, trustedKeys: this.trustedKeys, allowUnsigned: true, maxArchiveBytes: this.maxArchiveBytes, maxUnpackedBytes: this.maxUnpackedBytes });
    const sha = await sha256(archive);
    const key = `${verified.manifest.id}@${verified.manifest.version}`;
    await this.store.set(`repository/local/${repository.id}/${key}`, archive);
    repository.packages.set(key, { manifest: verified.manifest, archive, sha256: sha });
    return { repositoryId: repository.id, id: verified.manifest.id, version: verified.manifest.version, sha256: sha };
  }

  async #removeLocal(repository, packageId, version) {
    const key = `${packageId}@${version}`;
    const existed = repository.packages.delete(key);
    await this.store.delete(`repository/local/${repository.id}/${key}`);
    return { removed: existed, id: packageId, version };
  }

  async #ready() { if (!this.initialized) await this.initialize(); }
  #priority(id) { return this.localRepositories.has(id) ? 1000 : this.config.repositories.find(item => item.id === id)?.priority || 0; }
}

function validateIndex(index, repositoryId) {
  if (!index || index.format !== 'NPR' || index.version !== 1 || !index.packages || typeof index.packages !== 'object' || Array.isArray(index.packages)) throw new NumiOSError('REPOSITORY_INDEX_INVALID', 'Repository index does not match NPR version 1.', { repositoryId });
  for (const [packageId, releases] of Object.entries(index.packages)) {
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(packageId) || !Array.isArray(releases)) throw new NumiOSError('REPOSITORY_INDEX_INVALID', 'Repository package entry is invalid.', { repositoryId, packageId });
    const seen = new Set();
    for (const release of releases) {
      if (!release || typeof release.version !== 'string' || typeof release.url !== 'string' || typeof release.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(release.sha256)) throw new NumiOSError('REPOSITORY_INDEX_INVALID', 'Repository release metadata is invalid.', { repositoryId, packageId });
      parseVersion(release.version);
      if (seen.has(release.version)) throw new NumiOSError('REPOSITORY_INDEX_INVALID', 'Repository index contains duplicate versions.', { packageId, version: release.version });
      seen.add(release.version);
    }
  }
}
function validateIndexUrl(value) {
  try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('unsupported'); }
  catch { throw new NumiOSError('REPOSITORY_CONFIG_INVALID', 'Repository index must be a credential-free HTTP(S) URL.', { index: value }); }
}
function compareVersion(a, b) { return compareVersions(a, b); }
function toBytes(input) { if (input instanceof Uint8Array) return input; if (input instanceof ArrayBuffer) return new Uint8Array(input); throw new NumiOSError('INVALID_ARGUMENT', 'Local package archive must be bytes.'); }
