import { NumiOSError } from '../../core/errors.js';

const SYSTEM_CAPABILITIES = Object.freeze([
  'system.admin', 'system.info', 'system.control', 'fs.read.system', 'fs.write.system',
  'fs.read.user', 'fs.write.user', 'fs.read.application', 'fs.read.library', 'fs.write.library',
  'fs.read.temp', 'fs.write.temp', 'fs.read.volume', 'fs.write.volume', 'device.access', 'device.write',
  'process.spawn', 'process.manage', 'ipc.use', 'ipc.share', 'service.manage', 'package.install', 'package.remove',
  'package.query', 'network.fetch', 'network.remoteMount', 'storage.read', 'storage.write',
  'security.audit', 'security.requestCapability', 'system.config', 'repository.manage'
]);

export class SecurityManager {
  constructor({ policy = {}, logger = null, userConsent = null } = {}) {
    this.policy = {};
    this.protectedPaths = [];
    this.logger = logger;
    this.userConsent = userConsent;
    this.principals = new Map();
    this.auditRecords = [];
    this.auditCapacity = 5000;
    this.updatePolicy(policy);
    this.registerPrincipal('system', SYSTEM_CAPABILITIES, { type: 'system', uid: 'system' });
  }

  updatePolicy(policy = {}) {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new NumiOSError('SECURITY_POLICY_INVALID', 'Security policy must be an object.');
    const protectedPaths = policy.protectedPaths ?? [];
    if (!Array.isArray(protectedPaths)) throw new NumiOSError('SECURITY_POLICY_INVALID', 'protectedPaths must be an array.');
    this.protectedPaths = protectedPaths.map(path => normalizeForPolicy(path));
    this.policy = policy;
    return { protectedPaths: [...this.protectedPaths] };
  }

  registerPrincipal(id, capabilities = [], metadata = {}) {
    if (typeof id !== 'string' || !id) throw new NumiOSError('INVALID_ARGUMENT', 'Principal id is required.');
    const caps = new Set(capabilities);
    const principal = { id, uid: metadata.uid || id, type: metadata.type || 'process', capabilities: caps, metadata: { ...metadata } };
    this.principals.set(id, principal);
    return publicPrincipal(principal);
  }

  updatePrincipal(id, capabilities, metadata = undefined) {
    const current = this.#principal(id);
    if (capabilities) current.capabilities = new Set(capabilities);
    if (metadata) current.metadata = { ...current.metadata, ...metadata };
    return publicPrincipal(current);
  }

  unregisterPrincipal(id) {
    if (id === 'system') return false;
    return this.principals.delete(id);
  }

  resolve(id) {
    if (typeof id === 'object' && id !== null) id = id.id;
    const principal = this.principals.get(id);
    if (!principal) throw new NumiOSError('UNAUTHORIZED_CALLER', 'The syscall caller is not a registered NumiOS principal.', { callerId: id });
    return { id: principal.id, uid: principal.uid, type: principal.type, processId: principal.metadata.processId ?? null, capabilities: [...principal.capabilities] };
  }

  has(identity, capability) {
    const principal = this.#principal(identity?.id || identity);
    return principal.capabilities.has('*') || principal.capabilities.has('system.admin') || principal.capabilities.has(capability);
  }

  assertCapability(identity, capability, { syscall = null } = {}) {
    if (!capability || capability === 'none' || capability === 'dynamic') return true;
    const principal = this.#principal(identity?.id || identity);
    if (principal.capabilities.has('*') || principal.capabilities.has('system.admin') || principal.capabilities.has(capability)) return true;
    this.audit({ eventCode: 'CAPABILITY_DENIED', outcome: 'denied', principal: principal.id, capability, syscall });
    throw new NumiOSError('CAPABILITY_DENIED', `Capability '${capability}' is required.`, { capability, syscall });
  }

  assertPathAccess(identity, path, operation) {
    const principal = this.#principal(identity?.id || identity);
    const normalized = normalizeForPolicy(path);
    const privileged = principal.capabilities.has('*') || principal.capabilities.has('system.admin');
    const isWrite = ['write', 'create', 'delete', 'rename', 'chmod', 'mount'].includes(operation);
    if (!privileged && isWrite && this.protectedPaths.some(root => under(normalized, root))) throw new NumiOSError('FS_PERMISSION_DENIED', 'This virtual path is protected from application writes.', { path: normalized, operation });
    const capability = requiredPathCapability(normalized, operation);
    if (capability === null) throw new NumiOSError('FS_PERMISSION_DENIED', 'This virtual path is protected from application access.', { path: normalized, operation });
    if (!principal.capabilities.has('*') && !principal.capabilities.has('system.admin') && !principal.capabilities.has(capability)) {
      this.audit({ eventCode: 'PATH_CAPABILITY_DENIED', outcome: 'denied', principal: principal.id, path: normalized, operation, capability });
      throw new NumiOSError('CAPABILITY_DENIED', `Capability '${capability}' is required for this path.`, { path: normalized, operation, capability });
    }
    return true;
  }

  async requestCapability(identity, capability, reason = '') {
    const principal = this.#principal(identity?.id || identity);
    if (typeof capability !== 'string' || !/^[a-z][a-z0-9]*(?:[._][a-zA-Z0-9-]+)+$/.test(capability)) throw new NumiOSError('INVALID_ARGUMENT', 'Capability name is invalid.');
    const approved = Boolean(await this.userConsent?.({ principal: principal.id, capability, reason: String(reason).slice(0, 500) }));
    this.audit({ eventCode: 'CAPABILITY_REQUEST', outcome: approved ? 'approved' : 'denied', principal: principal.id, capability });
    if (!approved) return { granted: false, capability };
    principal.capabilities.add(capability);
    return { granted: true, capability };
  }

  grantApplicationCapabilities(packageId, requested, policy = this.policy.applicationCapabilityAllowlist || []) {
    const allowed = new Set(policy);
    const denied = requested.filter(capability => !allowed.has(capability));
    if (denied.length && this.policy.denyLaunchWithUnapprovedCapabilities !== false) {
      throw new NumiOSError('CAPABILITY_POLICY_DENIED', 'Application requested capabilities that are not allowed by installation policy.', { packageId, denied });
    }
    return requested.filter(capability => allowed.has(capability));
  }

  audit(record) {
    const normalized = Object.freeze({ timestamp: new Date().toISOString(), subsystem: 'security', outcome: 'recorded', ...record });
    this.auditRecords.push(normalized);
    if (this.auditRecords.length > this.auditCapacity) this.auditRecords.splice(0, this.auditRecords.length - this.auditCapacity);
    this.logger?.info('security', normalized.eventCode || 'Security audit event.', normalized, normalized.principal || 'kernel');
    return normalized;
  }

  auditLog({ limit = 500, principal = null, outcome = null } = {}) {
    return this.auditRecords.filter(record => (!principal || record.principal === principal) && (!outcome || record.outcome === outcome)).slice(-Math.min(1000, limit)).map(record => ({ ...record }));
  }

  inspect(identity) { return publicPrincipal(this.#principal(identity?.id || identity)); }
  systemCapabilities() { return [...SYSTEM_CAPABILITIES]; }

  #principal(id) {
    const principal = this.principals.get(id);
    if (!principal) throw new NumiOSError('UNAUTHORIZED_CALLER', 'The syscall caller is not a registered NumiOS principal.', { callerId: id });
    return principal;
  }
}

function publicPrincipal(principal) {
  return { id: principal.id, uid: principal.uid, type: principal.type, capabilities: [...principal.capabilities], metadata: { ...principal.metadata } };
}

function normalizeForPolicy(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('..') || path.includes('\\') || path.includes('\u0000')) {
    throw new NumiOSError('INVALID_PATH', 'Path must be a normalized absolute virtual path.');
  }
  return path === '/' ? '/' : path.replace(/\/{2,}/g, '/').replace(/\/$/, '');
}

function under(path, root) { return path === root || path.startsWith(`${root}/`); }

function requiredPathCapability(path, operation) {
  const write = ['write', 'create', 'delete', 'rename', 'chmod', 'mount'].includes(operation);
  if (under(path, '/proc')) return write ? null : 'system.info';
  if (under(path, '/dev')) return write ? 'device.write' : 'device.access';
  if (under(path, '/System') || under(path, '/usr') || under(path, '/bin') || under(path, '/lib') || under(path, '/etc')) return write ? 'fs.write.system' : 'fs.read.system';
  if (under(path, '/Users')) return write ? 'fs.write.user' : 'fs.read.user';
  if (under(path, '/Apps')) return write ? 'package.install' : 'fs.read.application';
  if (under(path, '/Library')) return write ? 'fs.write.library' : 'fs.read.library';
  if (under(path, '/Temp')) return write ? 'fs.write.temp' : 'fs.read.temp';
  if (under(path, '/Volumes')) return write ? 'fs.write.volume' : 'fs.read.volume';
  if (under(path, '/var/log')) return write ? 'fs.write.system' : 'fs.read.system';
  if (under(path, '/var')) return write ? 'fs.write.system' : 'fs.read.system';
  return write ? 'fs.write.system' : 'fs.read.system';
}
