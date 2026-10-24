import { NumiOSError } from '../core/errors.js';
import { EventHub } from '../core/events.js';
import { parseJson, validateSchema } from '../core/schema.js';

const SERVICE_UNIT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['unit', 'service', 'dependencies', 'security', 'resources', 'enabled'],
  properties: {
    unit: { type: 'object', additionalProperties: false, required: ['name', 'description'], properties: { name: { type: 'string', pattern: '^[a-z0-9-]+\\.service$' }, description: { type: 'string', maxLength: 512 } } },
    service: { type: 'object', required: ['type', 'entry', 'restart', 'restartLimit', 'restartWindowMs'], properties: { type: { type: 'string', enum: ['builtin', 'worker'] }, entry: { type: 'string', maxLength: 512 }, restart: { type: 'string', enum: ['no', 'on-failure', 'always'] }, restartLimit: { type: 'integer', minimum: 0, maximum: 100 }, restartWindowMs: { type: 'integer', minimum: 1 }, restartBackoffMs: { type: 'integer', minimum: 0 } } },
    dependencies: { type: 'object', additionalProperties: false, properties: { requires: { type: 'array', items: { type: 'string' } }, after: { type: 'array', items: { type: 'string' } }, wants: { type: 'array', items: { type: 'string' } } } },
    security: { type: 'object', additionalProperties: false, required: ['capabilities'], properties: { capabilities: { type: 'array', uniqueItems: true, items: { type: 'string' } } } },
    resources: { type: 'object', additionalProperties: false, properties: { timeoutMs: { type: 'integer', minimum: 1 }, maxConcurrentTasks: { type: 'integer', minimum: 1 } } },
    enabled: { type: 'boolean' }
  }
};

export class ServiceManager {
  constructor({ vfs, processManager, security, logger, createSdk = null, builtins = {}, workerRuntime = null, schema = SERVICE_UNIT_SCHEMA, events = new EventHub(), clock = () => Date.now() } = {}) {
    this.vfs = vfs;
    this.processManager = processManager;
    this.security = security;
    this.logger = logger;
    this.createSdk = createSdk;
    this.builtins = builtins;
    this.workerRuntime = workerRuntime;
    this.schema = schema?.properties ? schema : SERVICE_UNIT_SCHEMA;
    this.events = events;
    this.clock = clock;
    this.definitions = new Map();
    this.runtime = new Map();
    this.initialized = false;
  }

  async loadUnits(directory = '/System/Services') {
    const entries = await this.vfs.readdir(directory);
    const units = [];
    for (const entry of entries.filter(item => item.type === 'file' && item.name.endsWith('.service'))) {
      const text = new TextDecoder().decode(await this.vfs.readFile(`${directory}/${entry.name}`));
      units.push(await this.register(parseJson(text, entry.name), { persist: false, expectedFilename: entry.name, identity: 'system' }));
    }
    this.initialized = true;
    return units;
  }

  async register(definition, { persist = true, expectedFilename = null, identity = 'system' } = {}) {
    validateSchema(definition, this.schema);
    const name = definition.unit.name;
    if (expectedFilename && name !== expectedFilename) throw new NumiOSError('SERVICE_UNIT_INVALID', 'Service filename must match unit.name.', { expectedFilename, name });
    if (definition.service.type === 'worker' && !definition.service.entry.startsWith('/')) throw new NumiOSError('SERVICE_UNIT_INVALID', 'Worker service entry must be an absolute virtual path.');
    const caller = typeof identity === 'string' ? identity : identity.id;
    const principal = this.security.resolve(caller);
    if (caller !== 'system') {
      this.security.assertCapability(principal, 'service.manage');
      for (const capability of definition.security.capabilities) this.security.assertCapability(principal, capability);
      if (definition.service.type === 'builtin') this.security.assertCapability(principal, 'system.admin');
    }
    const normalized = structuredCloneSafe(definition);
    if (persist) {
      const path = `/System/Services/${name}`;
      await this.vfs.writeFile(path, JSON.stringify(normalized, null, 2), { create: true, owner: 'system' });
    }
    this.definitions.set(name, normalized);
    if (!this.runtime.has(name)) this.runtime.set(name, runtimeRecord(name));
    if (persist) await this.logger?.info('service', 'Service unit registered.', { eventCode: 'SERVICE_REGISTERED', name });
    return { ...normalized };
  }

  async start(name, { reason = 'manual', dependencyStack = [] } = {}) {
    const definition = this.#definition(name);
    const runtime = this.#runtime(name);
    if (dependencyStack.includes(name)) throw new NumiOSError('SERVICE_DEPENDENCY_CYCLE', 'Service dependency cycle detected.', { cycle: [...dependencyStack, name] });
    if (runtime.state === 'active') return this.status(name);
    if (runtime.state === 'starting') throw new NumiOSError('SERVICE_STARTING', 'Service is already starting.', { name });
    if (!definition.enabled && reason !== 'manual-force') throw new NumiOSError('SERVICE_DISABLED', 'Service is disabled.', { name });
    runtime.state = 'starting';
    runtime.lastError = null;
    runtime.lastTransitionAt = new Date(this.clock()).toISOString();
    this.#emit('service.state', name);
    const stack = [...dependencyStack, name];
    try {
      for (const dependency of definition.dependencies.requires || []) {
        if (!this.definitions.has(dependency)) throw new NumiOSError('SERVICE_DEPENDENCY_MISSING', 'Required service unit is missing.', { service: name, dependency });
        await this.start(dependency, { reason: 'dependency', dependencyStack: stack });
      }
      for (const dependency of definition.dependencies.after || []) {
        if (this.definitions.has(dependency) && this.#runtime(dependency).state !== 'active' && this.#definition(dependency).enabled) {
          try { await this.start(dependency, { reason: 'ordering', dependencyStack: stack }); }
          catch (error) { if ((definition.dependencies.requires || []).includes(dependency)) throw error; }
        }
      }
      for (const dependency of definition.dependencies.wants || []) {
        if (this.definitions.has(dependency) && this.#runtime(dependency).state !== 'active') {
          try { await this.start(dependency, { reason: 'wanted', dependencyStack: stack }); }
          catch (error) { await this.logger?.warn('service', 'Wanted service failed to start; continuing.', { eventCode: 'SERVICE_WANT_FAILED', service: name, dependency, error: error.message }); }
        }
      }
      return await this.#startUnit(definition, runtime, reason);
    } catch (error) {
      runtime.state = 'failed';
      runtime.lastError = normalizeError(error);
      runtime.failedAt = new Date(this.clock()).toISOString();
      runtime.lastTransitionAt = runtime.failedAt;
      this.#emit('service.state', name);
      await this.logger?.error('service', 'Service failed to start.', { eventCode: 'SERVICE_START_FAILED', service: name, error: runtime.lastError });
      this.#scheduleRestart(name, error);
      throw error;
    }
  }

  async #startUnit(definition, runtime, reason) {
    const name = definition.unit.name;
    const process = this.processManager.create({
      caller: 'system', name, type: 'service', serviceName: name,
      capabilities: definition.security.capabilities,
      resourceLimits: { timeoutMs: definition.resources.timeoutMs || 10000 },
      metadata: { unit: name, restart: definition.service.restart }
    });
    runtime.pid = process.pid;
    runtime.lastPid = process.pid;
    runtime.startedAt = new Date(this.clock()).toISOString();
    runtime.restartTimes.push(this.clock());
    const sdk = this.createSdk?.(process.pid, { serviceName: name, pid: process.pid });
    const context = { name, pid: process.pid, sdk, signal: this.processManager.identity(process.pid), logger: this.logger, reason, definition };
    try {
      let handle;
      if (definition.service.type === 'builtin') {
        const factory = this.builtins[definition.service.entry];
        if (typeof factory !== 'function') throw new NumiOSError('SERVICE_ENTRY_NOT_FOUND', 'Built-in service adapter is not registered.', { entry: definition.service.entry });
        handle = await withTimeout(factory(context), definition.resources.timeoutMs || 10000, 'SERVICE_START_TIMEOUT');
        this.processManager.start(process.pid);
      } else {
        if (!this.workerRuntime) throw new NumiOSError('WORKER_UNAVAILABLE', 'Worker service runtime is unavailable.');
        handle = await this.workerRuntime.startService({ definition, pid: process.pid, sdk, processManager: this.processManager });
      }
      runtime.handle = handle || {};
      runtime.state = 'active';
      runtime.lastError = null;
      runtime.lastTransitionAt = new Date(this.clock()).toISOString();
      this.#emit('service.state', name);
      await this.logger?.info('service', 'Service started.', { eventCode: 'SERVICE_STARTED', service: name, pid: process.pid, reason }, `pid:${process.pid}`);
      return this.status(name);
    } catch (error) {
      runtime.pid = null;
      await this.processManager.exit(process.pid, { failed: true, exitCode: 1, error });
      throw error;
    }
  }

  async stop(name, { reason = 'manual' } = {}) {
    const definition = this.#definition(name);
    const runtime = this.#runtime(name);
    if (runtime.state === 'inactive') return this.status(name);
    runtime.state = 'stopping';
    runtime.lastTransitionAt = new Date(this.clock()).toISOString();
    this.#emit('service.state', name);
    let error = null;
    try { await runtime.handle?.stop?.({ reason }); }
    catch (cause) { error = cause; }
    if (runtime.pid !== null) await this.processManager.terminate(runtime.pid, { caller: 'system', exitCode: 0 });
    runtime.pid = null;
    runtime.handle = null;
    runtime.state = error ? 'failed' : 'inactive';
    runtime.lastError = error ? normalizeError(error) : null;
    runtime.stoppedAt = new Date(this.clock()).toISOString();
    runtime.lastTransitionAt = runtime.stoppedAt;
    this.#emit('service.state', name);
    await this.logger?.info('service', error ? 'Service stop completed with an error.' : 'Service stopped.', { eventCode: error ? 'SERVICE_STOP_FAILED' : 'SERVICE_STOPPED', service: name, error: runtime.lastError });
    if (error) throw error;
    return this.status(name);
  }

  async restart(name) {
    const definition = this.#definition(name);
    const runtime = this.#runtime(name);
    runtime.manualRestart = true;
    clearTimeout(runtime.restartTimer);
    runtime.restartTimer = null;
    if (runtime.state !== 'inactive') await this.stop(name, { reason: 'restart' });
    runtime.manualRestart = false;
    return this.start(name, { reason: 'restart' });
  }

  async startAll() {
    const order = this.order();
    const started = [];
    const failures = [];
    for (const name of order) {
      const definition = this.#definition(name);
      if (!definition.enabled) continue;
      try { await this.start(name, { reason: 'boot' }); started.push(name); }
      catch (error) {
        failures.push({ name, code: error.code || 'SERVICE_START_FAILED', message: error.message });
        if ((definition.dependencies.requires || []).some(dep => this.#runtime(dep)?.state !== 'active')) continue;
      }
    }
    return { started, failures, order };
  }

  async stopAll() {
    const order = this.order().reverse();
    const stopped = [];
    const failures = [];
    for (const name of order) {
      if (this.#runtime(name).state === 'inactive') continue;
      try { await this.stop(name, { reason: 'shutdown' }); stopped.push(name); }
      catch (error) { failures.push({ name, message: error.message }); }
    }
    return { stopped, failures, order };
  }

  order() {
    const output = [];
    const temporary = new Set();
    const permanent = new Set();
    const visit = (name, chain) => {
      if (permanent.has(name)) return;
      if (temporary.has(name)) throw new NumiOSError('SERVICE_DEPENDENCY_CYCLE', 'Service dependency cycle detected.', { cycle: [...chain, name] });
      const definition = this.definitions.get(name);
      if (!definition) throw new NumiOSError('SERVICE_DEPENDENCY_MISSING', 'Service dependency is missing.', { name });
      temporary.add(name);
      const dependencies = [...new Set([...(definition.dependencies.requires || []), ...(definition.dependencies.after || []), ...(definition.dependencies.wants || [])])];
      for (const dependency of dependencies) {
        if (!this.definitions.has(dependency)) {
          if ((definition.dependencies.requires || []).includes(dependency)) throw new NumiOSError('SERVICE_DEPENDENCY_MISSING', 'Required service unit is missing.', { service: name, dependency });
          continue;
        }
        visit(dependency, [...chain, name]);
      }
      temporary.delete(name);
      permanent.add(name);
      output.push(name);
    };
    for (const name of this.definitions.keys()) visit(name, []);
    return output;
  }

  enable(name) { const definition = this.#definition(name); definition.enabled = true; return this.status(name); }
  disable(name) { const definition = this.#definition(name); definition.enabled = false; return this.status(name); }
  status(name) {
    const runtime = this.#runtime(name);
    const definition = this.#definition(name);
    return { ...runtimePublic(runtime), enabled: definition.enabled, description: definition.unit.description, dependencies: structuredCloneSafe(definition.dependencies), capabilities: [...definition.security.capabilities] };
  }
  list({ state = null } = {}) { return [...this.definitions.keys()].map(name => this.status(name)).filter(item => !state || item.state === state); }
  dependencies(name) { const definition = this.#definition(name); return structuredCloneSafe(definition.dependencies); }
  logs(name, limit = 100) {
    const runtime = this.#runtime(name);
    const pid = runtime.pid ?? runtime.lastPid;
    return this.logger?.query({ limit, identity: pid === null || pid === undefined ? name : `pid:${pid}` }) || [];
  }

  async reportFailure(name, error) {
    const runtime = this.#runtime(name);
    if (runtime.pid !== null) await this.processManager.exit(runtime.pid, { failed: true, exitCode: 1, error });
    runtime.state = 'failed';
    runtime.lastError = normalizeError(error);
    runtime.failedAt = new Date(this.clock()).toISOString();
    runtime.pid = null;
    runtime.handle = null;
    this.#emit('service.state', name);
    this.#scheduleRestart(name, error);
    return this.status(name);
  }

  #scheduleRestart(name, error) {
    const definition = this.definitions.get(name);
    const runtime = this.runtime.get(name);
    if (!definition || !runtime || runtime.manualRestart) return;
    const policy = definition.service.restart;
    if (policy !== 'always' && !(policy === 'on-failure' && runtime.state === 'failed')) return;
    const now = this.clock();
    runtime.restartTimes = runtime.restartTimes.filter(time => now - time <= definition.service.restartWindowMs);
    if (runtime.restartTimes.length >= definition.service.restartLimit) {
      runtime.lastError = { code: 'SERVICE_RESTART_LIMIT', message: `Restart limit reached after: ${error?.message || 'failure'}` };
      return;
    }
    const backoff = Math.min(30000, (definition.service.restartBackoffMs || 0) * (2 ** Math.max(0, runtime.restartTimes.length - 1)));
    clearTimeout(runtime.restartTimer);
    runtime.restartTimer = setTimeout(() => {
      runtime.restartTimer = null;
      void this.start(name, { reason: 'automatic-restart' }).catch(() => {});
    }, backoff);
    this.#emit('service.restartScheduled', { name, backoffMs: backoff });
  }

  async shutdown() {
    for (const runtime of this.runtime.values()) clearTimeout(runtime.restartTimer);
    return this.stopAll();
  }

  #definition(name) {
    const definition = this.definitions.get(name);
    if (!definition) throw new NumiOSError('SERVICE_NOT_FOUND', 'Service unit does not exist.', { name });
    return definition;
  }
  #runtime(name) {
    let runtime = this.runtime.get(name);
    if (!runtime) { runtime = runtimeRecord(name); this.runtime.set(name, runtime); }
    return runtime;
  }
  #emit(event, name) { this.events.emit(event, typeof name === 'string' ? this.status(name) : name); }
}

function runtimeRecord(name) { return { name, state: 'inactive', pid: null, lastPid: null, startedAt: null, stoppedAt: null, failedAt: null, lastTransitionAt: null, lastError: null, restartTimes: [], restartTimer: null, handle: null, manualRestart: false }; }
function runtimePublic(runtime) { return { name: runtime.name, state: runtime.state, pid: runtime.pid, startedAt: runtime.startedAt, stoppedAt: runtime.stoppedAt, failedAt: runtime.failedAt, lastTransitionAt: runtime.lastTransitionAt, lastError: runtime.lastError, restartCount: runtime.restartTimes.length }; }
function normalizeError(error) { return { code: error?.code || 'SERVICE_FAILED', message: error?.message || String(error) }; }
function structuredCloneSafe(value) { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
function withTimeout(promise, timeoutMs, code) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new NumiOSError(code, `Service operation exceeded ${timeoutMs}ms.`)), timeoutMs); })]).finally(() => clearTimeout(timer));
}
