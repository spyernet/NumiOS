import { createRequestId } from '../core/ids.js';
import { NumiOSError } from '../core/errors.js';

export class SyscallClient {
  constructor(port, { defaultTimeoutMs = 30000, maxTimeoutMs = 120000 } = {}) {
    if (!port || typeof port.postMessage !== 'function') throw new NumiOSError('INVALID_ARGUMENT', 'SyscallClient requires a MessagePort.');
    this.port = port;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.maxTimeoutMs = maxTimeoutMs;
    this.pending = new Map();
    this.closed = false;
    this.onMessage = event => this.#receive(event.data);
    this.onMessageError = () => this.close(new NumiOSError('IPC_MESSAGE_ERROR', 'Syscall response could not be decoded.'));
    port.addEventListener?.('message', this.onMessage);
    port.addEventListener?.('messageerror', this.onMessageError);
    if (!port.addEventListener) {
      port.onmessage = this.onMessage;
      port.onmessageerror = this.onMessageError;
    }
    port.start?.();
  }

  call(syscall, args = {}, { signal = undefined, timeoutMs = this.defaultTimeoutMs } = {}) {
    if (this.closed) return Promise.reject(new NumiOSError('SYSCALL_CONNECTION_CLOSED', 'Syscall connection is closed.'));
    if (typeof syscall !== 'string' || !syscall) return Promise.reject(new NumiOSError('INVALID_ARGUMENT', 'Syscall name is required.'));
    if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    const id = createRequestId();
    const timeout = Math.min(this.maxTimeoutMs, Math.max(1, Number.isFinite(timeoutMs) ? timeoutMs : this.defaultTimeoutMs));
    return new Promise((resolve, reject) => {
      let timer;
      const onAbort = () => {
        this.port.postMessage({ protocol: 'numios-syscall', version: 1, type: 'cancel', id });
        this.#settle(id, null, signal.reason || new NumiOSError('CANCELLED', 'Syscall call was cancelled.'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        this.port.postMessage({ protocol: 'numios-syscall', version: 1, type: 'cancel', id });
        this.#settle(id, null, new NumiOSError('SYSCALL_TIMEOUT', `Syscall '${syscall}' timed out in the client.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, signal, onAbort });
      try {
        this.port.postMessage({ protocol: 'numios-syscall', version: 1, type: 'request', id, syscall, args, timeoutMs: timeout });
      } catch (error) {
        this.#settle(id, null, new NumiOSError('IPC_MESSAGE_ERROR', 'Syscall request could not be sent.', { cause: error.message }));
      }
    });
  }

  close(reason = new NumiOSError('SYSCALL_CONNECTION_CLOSED', 'Syscall connection closed.')) {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.pending.keys()]) this.#settle(id, null, reason);
    this.port.removeEventListener?.('message', this.onMessage);
    this.port.removeEventListener?.('messageerror', this.onMessageError);
    this.port.close?.();
  }

  #receive(message) {
    if (!message || message.protocol !== 'numios-syscall' || message.version !== 1 || message.type !== 'response') return;
    if (typeof message.requestId !== 'string' || typeof message.ok !== 'boolean') return;
    const envelope = { ok: message.ok, data: message.data ?? null, error: message.error ?? null, requestId: message.requestId };
    this.#settle(message.requestId, envelope, null);
  }

  #settle(id, result, error) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.onAbort);
    if (error) pending.reject(error);
    else pending.resolve(result);
  }
}

export function syscallGroups(client) {
  const group = prefix => new Proxy({}, { get: (_target, method) => args => client.call(`${prefix}.${String(method)}`, args) });
  return Object.freeze({
    call: (name, args, options) => client.call(name, args, options),
    process: group('process'), fs: group('fs'), memory: group('memory'), resource: group('resource'),
    ipc: group('ipc'), service: group('service'), package: group('package'), app: group('app'),
    system: group('system'), security: group('security'), network: group('network'), device: group('device'), disk: group('disk'), repository: group('repository'), config: group('config'), log: group('log'), diagnostics: group('diagnostics')
  });
}
