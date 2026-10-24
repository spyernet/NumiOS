import { createRequestId } from '../../core/ids.js';
import { NumiOSError, resultError, resultOk } from '../../core/errors.js';
import { validateSchema } from '../../core/schema.js';

export class SyscallDispatcher {
  constructor({ registry, security, processManager = null, logger = null, defaultTimeoutMs = 30000, maxTimeoutMs = 120000 } = {}) {
    this.registry = registry;
    this.security = security;
    this.processManager = processManager;
    this.logger = logger;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.maxTimeoutMs = maxTimeoutMs;
    this.initialized = false;
    this.failureCount = 0;
  }

  initialize() {
    if (!this.registry.sealed) this.registry.seal();
    this.initialized = true;
  }

  async call(name, args = {}, { callerId = 'system', signal = undefined, timeoutMs = undefined, requestId = createRequestId() } = {}) {
    if (!this.initialized) return resultError(new NumiOSError('KERNEL_NOT_READY', 'Syscall dispatcher is not initialized.'), requestId);
    if (typeof requestId !== 'string' || requestId.length > 160) requestId = createRequestId();
    const entry = this.registry.get(name);
    if (!entry) return resultError(new NumiOSError('UNKNOWN_SYSCALL', 'Syscall is not registered.', { syscall: name }), requestId);
    if (!args || typeof args !== 'object' || Array.isArray(args)) return resultError(new NumiOSError('INVALID_ARGUMENT', 'Syscall arguments must be a JSON object.'), requestId);
    let controller;
    let timer;
    let onAbort;
    try {
      validateSchema(args, entry.definition.schema);
      const identity = this.security.resolve(callerId);
      if (identity.processId !== null && this.processManager) this.processManager.identity(identity.processId);
      this.security.assertCapability(identity, entry.definition.capability, { syscall: name });
      controller = new AbortController();
      onAbort = () => controller.abort(signal.reason || new DOMException('Aborted', 'AbortError'));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const requestedTimeout = Number.isFinite(timeoutMs) ? timeoutMs : this.defaultTimeoutMs;
      const effectiveTimeout = Math.min(this.maxTimeoutMs, Math.max(1, requestedTimeout));
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new NumiOSError('SYSCALL_TIMEOUT', `Syscall '${name}' exceeded its time limit.`, { timeoutMs: effectiveTimeout }));
          reject(new NumiOSError('SYSCALL_TIMEOUT', `Syscall '${name}' exceeded its time limit.`, { timeoutMs: effectiveTimeout }));
        }, effectiveTimeout);
      });
      const execution = Promise.resolve().then(() => entry.handler(args, {
        identity, callerId: identity.id, signal: controller.signal, requestId,
        timeoutMs: effectiveTimeout, dispatcher: this
      }));
      const data = await Promise.race([execution, timeoutPromise]);
      if (controller.signal.aborted) throw controller.signal.reason || new NumiOSError('CANCELLED', 'Syscall was cancelled.');
      this.security.audit({ eventCode: 'SYSCALL_ALLOWED', outcome: 'allowed', principal: identity.id, syscall: name, requestId });
      return resultOk(data ?? null, requestId);
    } catch (error) {
      this.failureCount += 1;
      this.logger?.warn('syscall', 'Syscall request failed.', { eventCode: 'SYSCALL_FAILED', syscall: name, requestId, code: error.code || 'INTERNAL_ERROR', message: error.message }, callerId);
      return resultError(error, requestId);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  list() { return this.registry.list(); }
  status() { return { initialized: this.initialized, count: this.registry.list().length, failures: this.failureCount, version: this.registry.tableVersion }; }
}

/** The port is bound by kernel code to a principal. Caller identity is never read from app messages. */
export class SyscallHost {
  constructor(dispatcher, { maxInFlight = 64 } = {}) {
    this.dispatcher = dispatcher;
    this.maxInFlight = maxInFlight;
    this.connections = new Set();
  }

  attach(port, principalId) {
    if (!port || typeof port.postMessage !== 'function') throw new NumiOSError('INVALID_ARGUMENT', 'A MessagePort-like endpoint is required.');
    this.dispatcher.security.resolve(principalId);
    const connection = { port, principalId, active: new Map(), closed: false };
    const onMessage = event => { void this.#receive(connection, event.data); };
    const onMessageError = () => this.#close(connection);
    port.addEventListener?.('message', onMessage);
    port.addEventListener?.('messageerror', onMessageError);
    if (!port.addEventListener) {
      port.onmessage = onMessage;
      port.onmessageerror = onMessageError;
    }
    port.start?.();
    connection.detach = () => {
      port.removeEventListener?.('message', onMessage);
      port.removeEventListener?.('messageerror', onMessageError);
      this.#close(connection);
    };
    this.connections.add(connection);
    return connection.detach;
  }

  closeAll() { for (const connection of [...this.connections]) connection.detach(); }

  async #receive(connection, message) {
    if (connection.closed) return;
    if (isObject(message) && message.protocol === 'numios-syscall' && message.version === 1 && message.type === 'cancel' && typeof message.id === 'string') {
      connection.active.get(message.id)?.abort(new NumiOSError('CANCELLED', 'Caller cancelled the syscall.'));
      return;
    }
    const messageId = isObject(message) && typeof message.id === 'string' ? message.id : null;
    if (!isObject(message) || message.protocol !== 'numios-syscall' || message.version !== 1 || message.type !== 'request'
      || !validKeys(message, ['protocol', 'version', 'type', 'id', 'syscall', 'args', 'timeoutMs'])
      || !messageId || messageId.length > 160 || typeof message.syscall !== 'string' || !isObject(message.args)
      || (message.timeoutMs !== undefined && (!Number.isSafeInteger(message.timeoutMs) || message.timeoutMs < 1 || message.timeoutMs > 120000))) {
      this.#post(connection, resultError(new NumiOSError('MALFORMED_MESSAGE', 'Syscall message does not match the NumiOS message protocol.'), messageId));
      return;
    }
    if (connection.active.has(messageId)) {
      this.#post(connection, resultError(new NumiOSError('DUPLICATE_REQUEST_ID', 'Request id is already active.'), messageId));
      return;
    }
    if (connection.active.size >= this.maxInFlight) {
      this.#post(connection, resultError(new NumiOSError('RESOURCE_LIMIT', 'Too many in-flight syscalls.'), messageId));
      return;
    }
    const controller = new AbortController();
    connection.active.set(messageId, controller);
    try {
      const result = await this.dispatcher.call(message.syscall, message.args, {
        callerId: connection.principalId, signal: controller.signal, timeoutMs: message.timeoutMs, requestId: messageId
      });
      this.#post(connection, result);
    } finally {
      connection.active.delete(messageId);
    }
  }

  #post(connection, message) {
    if (connection.closed) return;
    try { connection.port.postMessage({ protocol: 'numios-syscall', version: 1, type: 'response', ...message }); }
    catch { this.#close(connection); }
  }

  #close(connection) {
    if (connection.closed) return;
    connection.closed = true;
    for (const controller of connection.active.values()) controller.abort(new NumiOSError('CANCELLED', 'Syscall connection closed.'));
    connection.active.clear();
    connection.port.close?.();
    this.connections.delete(connection);
  }
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validKeys(object, allowed) { return Object.keys(object).every(key => allowed.includes(key)); }
