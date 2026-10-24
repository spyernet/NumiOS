import { EventHub } from '../../core/events.js';
import { NumiOSError } from '../../core/errors.js';
import { SecurityManager } from '../security/security-manager.js';

const TERMINAL = new Set(['terminated', 'failed']);

export class ProcessManager {
  constructor({ security, scheduler, resources, vfs, ipc = null, logger = null, events = new EventHub(), maxProcesses = 256 } = {}) {
    if (!security || !scheduler || !resources) throw new NumiOSError('INVALID_ARGUMENT', 'ProcessManager requires security, scheduler, and resources.');
    this.security = security;
    this.scheduler = scheduler;
    this.resources = resources;
    this.vfs = vfs;
    this.ipc = ipc;
    this.logger = logger;
    this.events = events;
    this.maxProcesses = maxProcesses;
    this.processes = new Map();
    this.nextPid = 100;
    this.shuttingDown = false;
  }

  create({ caller = 'system', parentPid = undefined, name = 'process', type = 'task', packageId = null, serviceName = null, uid = undefined, args = [], env = {}, capabilities = [], priority = 0, resourceLimits = {}, metadata = {} } = {}) {
    if (this.shuttingDown) throw new NumiOSError('SYSTEM_SHUTTING_DOWN', 'New processes cannot be created during shutdown.');
    const activeCount = [...this.processes.values()].filter(process => !TERMINAL.has(process.state)).length;
    if (activeCount >= Math.min(this.maxProcesses, this.resources.maxProcesses)) throw new NumiOSError('RESOURCE_LIMIT', 'Maximum logical process count reached.');
    const callerId = typeof caller === 'string' ? caller : caller.id;
    const parentPrincipal = this.security.resolve(callerId);
    const resolvedParent = callerId === 'system' ? (parentPid === undefined ? null : parentPid) : parentPrincipal.processId;
    if (callerId !== 'system' && parentPid !== undefined && parentPid !== resolvedParent) throw new NumiOSError('PROCESS_PARENT_DENIED', 'A caller cannot assign a different process as its child parent.');
    if (resolvedParent !== null && resolvedParent !== undefined && !this.processes.has(resolvedParent)) throw new NumiOSError('PROCESS_NOT_FOUND', 'Parent process does not exist.', { parentPid: resolvedParent });
    const requested = normalizeCapabilities(capabilities);
    if (callerId !== 'system') {
      const parentCapabilities = new Set(parentPrincipal.capabilities);
      const denied = requested.filter(capability => !parentCapabilities.has(capability));
      if (denied.length) throw new NumiOSError('CAPABILITY_DELEGATION_DENIED', 'A process cannot grant capabilities it does not hold.', { denied });
    }
    const pid = this.nextPid++;
    const principalId = `pid:${pid}`;
    const startedAt = Date.now();
    const controller = new AbortController();
    const record = {
      pid, principalId, parentPid: resolvedParent ?? null, name: sanitizeName(name), type, packageId, serviceName,
      uid: String(uid || parentPrincipal.uid || 'system'), state: 'created', createdAt: new Date(startedAt).toISOString(), startedAt: null, endedAt: null,
      args: normalizeArgs(args), env: normalizeEnv(env), capabilities: requested, priority: safePriority(priority),
      resourceUsage: { cpuTimeMs: 0, logicalMemoryBytes: 0, fileHandles: 0 }, resourceLimits: { ...resourceLimits },
      exitCode: null, error: null, metadata: structuredCloneSafe(metadata), controller, worker: null, task: null,
      waiters: [], cleanups: new Set(),
      exitPromise: null, resolveExit: null
    };
    record.exitPromise = new Promise(resolve => { record.resolveExit = resolve; });
    this.processes.set(pid, record);
    this.security.registerPrincipal(principalId, requested, { type, processId: pid, packageId, serviceName, name: record.name, uid: record.uid });
    this.resources.setProcessLimits(pid, resourceLimits);
    this.#transition(record, 'ready');
    if (resolvedParent !== null) this.#emit('process.child', { parentPid: resolvedParent, pid });
    void this.logger?.info('process', 'Logical process created.', { eventCode: 'PROCESS_CREATED', pid, type }, principalId);
    return publicProcess(record);
  }

  async runTask({ caller = 'system', task, timeoutMs = 10000, ...options } = {}) {
    if (typeof task !== 'function') throw new NumiOSError('INVALID_ARGUMENT', 'Process task must be a function.');
    const created = this.create({ caller, ...options });
    const record = this.#record(created.pid);
    record.startedAt = new Date().toISOString();
    this.#transition(record, 'running');
    const start = performanceNow();
    record.task = this.scheduler.schedule(({ signal }) => task({ pid: record.pid, signal, identity: this.security.resolve(record.principalId) }), {
      priority: record.priority,
      timeoutMs: Math.min(timeoutMs, record.resourceLimits.timeoutMs || timeoutMs),
      signal: record.controller.signal,
      identity: record.principalId,
      label: record.name
    });
    record.task.then(async value => {
      record.resourceUsage.cpuTimeMs += performanceNow() - start;
      await this.exit(record.pid, { exitCode: 0, result: value });
    }).catch(async error => {
      record.resourceUsage.cpuTimeMs += performanceNow() - start;
      await this.exit(record.pid, { failed: error.code !== 'CANCELLED', exitCode: error.code === 'CANCELLED' ? 130 : 1, error });
    });
    return created.pid;
  }

  start(pid) {
    const record = this.#record(pid);
    if (record.state !== 'ready') throw new NumiOSError('PROCESS_STATE_INVALID', 'Only a ready process can start.', { pid, state: record.state });
    record.startedAt = new Date().toISOString();
    this.#transition(record, 'running');
    return publicProcess(record);
  }

  attachWorker(pid, worker, { cleanup = null } = {}) {
    const record = this.#record(pid);
    if (record.state !== 'ready' && record.state !== 'created') throw new NumiOSError('PROCESS_STATE_INVALID', 'Worker can only be attached to a ready process.', { state: record.state });
    record.worker = worker;
    if (cleanup) record.cleanups.add(cleanup);
    record.startedAt = new Date().toISOString();
    this.#transition(record, 'running');
    return publicProcess(record);
  }

  addCleanup(pid, cleanup) {
    if (typeof cleanup !== 'function') throw new NumiOSError('INVALID_ARGUMENT', 'Process cleanup must be a function.');
    this.#record(pid).cleanups.add(cleanup);
  }

  async suspend(pid, { caller = 'system' } = {}) {
    const record = this.#authorizeTarget(pid, caller);
    if (record.state !== 'running' && record.state !== 'blocked') throw new NumiOSError('PROCESS_STATE_INVALID', 'Only running or blocked processes can be suspended.');
    try { record.worker?.postMessage({ type: 'numios:suspend' }); } catch {}
    this.#transition(record, 'suspended');
    return publicProcess(record);
  }

  async resume(pid, { caller = 'system' } = {}) {
    const record = this.#authorizeTarget(pid, caller);
    if (record.state !== 'suspended') throw new NumiOSError('PROCESS_STATE_INVALID', 'Process is not suspended.');
    try { record.worker?.postMessage({ type: 'numios:resume' }); } catch {}
    this.#transition(record, 'running');
    return publicProcess(record);
  }

  async signal(pid, signal, { caller = 'system' } = {}) {
    if (signal === 'terminate' || signal === 'kill' || signal === 'interrupt') return this.terminate(pid, { caller, exitCode: signal === 'interrupt' ? 130 : 143 });
    if (signal === 'suspend') return this.suspend(pid, { caller });
    if (signal === 'resume') return this.resume(pid, { caller });
    throw new NumiOSError('INVALID_ARGUMENT', 'Unsupported process signal.', { signal });
  }

  async terminate(pid, { caller = 'system', exitCode = 143, force = true } = {}) {
    const record = this.#authorizeTarget(pid, caller);
    if (TERMINAL.has(record.state)) return publicProcess(record);
    record.controller.abort(new NumiOSError('CANCELLED', 'Process was terminated.'));
    if (record.worker) {
      if (force) record.worker.terminate?.();
      else record.worker.postMessage?.({ type: 'numios:terminate' });
      record.worker = null;
    }
    const children = [...this.processes.values()].filter(child => child.parentPid === pid && !TERMINAL.has(child.state));
    for (const child of children) await this.terminate(child.pid, { caller: 'system', exitCode: 143 });
    await this.exit(pid, { exitCode, failed: false });
    return publicProcess(record);
  }

  async exit(pid, { exitCode = 0, error = null, failed = false, result = undefined } = {}) {
    const record = this.processes.get(pid);
    if (!record || TERMINAL.has(record.state)) return record ? publicProcess(record) : null;
    record.endedAt = new Date().toISOString();
    record.exitCode = exitCode;
    record.error = error ? { code: error.code || 'PROCESS_FAILED', message: error.message || String(error) } : null;
    record.result = result;
    record.controller.abort(new NumiOSError('PROCESS_EXITED', 'Process has exited.'));
    record.worker?.terminate?.();
    record.worker = null;
    const cleanupErrors = [];
    for (const cleanup of [...record.cleanups].reverse()) {
      try { await cleanup(); } catch (cause) { cleanupErrors.push(cause.message); }
    }
    record.cleanups.clear();
    this.vfs?.closeProcess(pid);
    this.ipc?.closeProcess?.(pid);
    this.resources.releaseProcess(pid);
    this.security.unregisterPrincipal(record.principalId);
    this.#transition(record, failed ? 'failed' : 'terminated');
    const publicRecord = publicProcess(record);
    record.resolveExit(publicRecord);
    this.#emit('process.exit', { process: publicRecord, cleanupErrors });
    await this.logger?.info('process', failed ? 'Logical process failed.' : 'Logical process exited.', { eventCode: failed ? 'PROCESS_FAILED' : 'PROCESS_EXITED', pid, exitCode, error: record.error, cleanupErrors }, record.principalId);
    return publicRecord;
  }

  async wait(pid, { signal, timeoutMs } = {}) {
    const record = this.#record(pid);
    if (TERMINAL.has(record.state)) return publicProcess(record);
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    let timer;
    let abort;
    try {
      const wait = record.exitPromise;
      const cancellation = signal ? new Promise((_, reject) => {
        abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
      }) : new Promise(() => {});
      const timeout = Number.isFinite(timeoutMs) ? new Promise((_, reject) => {
        timer = setTimeout(() => reject(new NumiOSError('TIMEOUT', 'Timed out waiting for process exit.', { pid })), timeoutMs);
      }) : new Promise(() => {});
      return await Promise.race([wait, cancellation, timeout]);
    } finally {
      clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
    }
  }

  get(pid) { const record = this.processes.get(Number(pid)); return record ? publicProcess(record) : null; }
  list({ state = null, type = null, parentPid = undefined } = {}) {
    return [...this.processes.values()].filter(record => (!state || record.state === state) && (!type || record.type === type) && (parentPid === undefined || record.parentPid === parentPid)).map(publicProcess).sort((a, b) => a.pid - b.pid);
  }

  identity(pid) {
    const record = this.#record(pid);
    if (TERMINAL.has(record.state)) throw new NumiOSError('PROCESS_EXITED', 'Process is no longer an active syscall caller.', { pid });
    return this.security.resolve(record.principalId);
  }

  async shutdown() {
    this.shuttingDown = true;
    const active = [...this.processes.values()].filter(record => !TERMINAL.has(record.state)).sort((a, b) => b.pid - a.pid);
    for (const record of active) await this.terminate(record.pid, { caller: 'system', exitCode: 0 });
    return { terminated: active.length };
  }

  #authorizeTarget(pid, caller) {
    const record = this.#record(pid);
    const callerId = typeof caller === 'string' ? caller : caller.id;
    const identity = this.security.resolve(callerId);
    if (callerId !== 'system' && identity.processId !== record.parentPid && identity.processId !== record.pid) {
      this.security.assertCapability(identity, 'process.manage');
    }
    return record;
  }

  #record(pid) {
    const record = this.processes.get(Number(pid));
    if (!record) throw new NumiOSError('PROCESS_NOT_FOUND', 'Logical process does not exist.', { pid });
    return record;
  }

  #transition(record, state) {
    const allowed = {
      created: ['ready', 'failed'], ready: ['running', 'terminated', 'failed'], running: ['blocked', 'suspended', 'terminated', 'failed'],
      blocked: ['running', 'suspended', 'terminated', 'failed'], suspended: ['running', 'terminated', 'failed'], terminated: [], failed: []
    };
    if (record.state !== state && !allowed[record.state]?.includes(state)) throw new NumiOSError('PROCESS_STATE_INVALID', `Invalid process transition ${record.state} -> ${state}.`, { pid: record.pid });
    const previous = record.state;
    record.state = state;
    this.#emit('process.state', { pid: record.pid, previous, state });
  }

  #emit(type, detail) { this.events.emit(type, detail); }
}

function publicProcess(record) {
  const { controller, worker, task, cleanups, resolveExit, exitPromise, waiters, ...safe } = record;
  return { ...safe, capabilities: [...record.capabilities], args: [...record.args], env: { ...record.env }, resourceUsage: { ...record.resourceUsage }, resourceLimits: { ...record.resourceLimits }, metadata: { ...record.metadata } };
}
function normalizeCapabilities(values) { if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw new NumiOSError('INVALID_ARGUMENT', 'Capabilities must be an array of strings.'); return [...new Set(values)]; }
function normalizeArgs(args) { if (!Array.isArray(args) || args.length > 256) throw new NumiOSError('INVALID_ARGUMENT', 'Process args must be an array of at most 256 items.'); return args.map(arg => { if (!['string', 'number', 'boolean'].includes(typeof arg)) throw new NumiOSError('INVALID_ARGUMENT', 'Process arguments must be scalar values.'); return String(arg).slice(0, 4096); }); }
function normalizeEnv(env) { if (!env || typeof env !== 'object' || Array.isArray(env)) throw new NumiOSError('INVALID_ARGUMENT', 'Process environment must be an object.'); return Object.fromEntries(Object.entries(env).slice(0, 128).map(([key, value]) => [String(key).slice(0, 128), String(value).slice(0, 4096)])); }
function sanitizeName(name) { const value = String(name).trim().slice(0, 128); if (!value) throw new NumiOSError('INVALID_ARGUMENT', 'Process name cannot be empty.'); return value; }
function safePriority(priority) { return Number.isFinite(priority) ? Math.max(-20, Math.min(20, Math.trunc(priority))) : 0; }
function structuredCloneSafe(value) { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
function performanceNow() { return globalThis.performance?.now?.() ?? Date.now(); }
