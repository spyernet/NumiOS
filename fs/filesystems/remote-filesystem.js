import { NumiOSError } from '../../core/errors.js';
import { normalizePath } from '../path.js';
import { assertFilesystemContract } from '../filesystem-contract.js';

/** JSON filesystem protocol client. See docs/remote-filesystem-protocol.md. */
export class RemoteFileSystem {
  constructor({ baseUrl, fetchImpl = globalThis.fetch, tokenProvider = null, readOnly = false, timeoutMs = 15000, retries = 2, cache = true } = {}) {
    if (typeof fetchImpl !== 'function') throw new NumiOSError('NETWORK_UNAVAILABLE', 'Fetch API is unavailable.');
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.tokenProvider = tokenProvider;
    this.readOnly = Boolean(readOnly);
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.cacheEnabled = cache;
    this.cache = new Map();
    this.readyPromise = null;
  }

  async ready() {
    if (!this.readyPromise) {
      let url;
      try { url = new URL(this.baseUrl); } catch { throw new NumiOSError('REMOTE_CONFIG_INVALID', 'Remote filesystem baseUrl must be an absolute URL.'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new NumiOSError('REMOTE_CONFIG_INVALID', 'Remote filesystem requires an HTTP(S) URL without embedded credentials.');
      this.baseUrl = url.href.replace(/\/$/, '');
      this.readyPromise = Promise.resolve(this);
    }
    return this.readyPromise;
  }

  async stat(path, { signal } = {}) {
    const normalized = normalizePath(path);
    const data = await this.#request('metadata', { path: normalized }, { signal, cacheKey: `stat:${normalized}` });
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new NumiOSError('REMOTE_PROTOCOL_ERROR', 'Remote metadata response must be a stat object.');
    return data;
  }
  async readdir(path, { signal } = {}) { return this.#request('list', { path: normalizePath(path) }, { signal, cacheKey: `list:${normalizePath(path)}` }); }

  async readFile(path, { signal } = {}) {
    const normalized = normalizePath(path);
    const result = await this.#request('read', { path: normalized }, { signal, cacheKey: `read:${normalized}` });
    if (!result || typeof result.data !== 'string') throw new NumiOSError('REMOTE_PROTOCOL_ERROR', 'Remote read response must contain base64 data.');
    try { return decodeBase64(result.data); }
    catch (error) { throw new NumiOSError('REMOTE_PROTOCOL_ERROR', 'Remote read response contains invalid base64 data.', { cause: error.message }); }
  }

  async writeFile(path, input, { signal } = {}) {
    this.#assertWritable();
    const normalized = normalizePath(path);
    const data = toBytes(input);
    const result = await this.#request('write', { path: normalized, data: encodeBase64(data) }, { signal, retry: false });
    this.#invalidate(normalized);
    return result;
  }

  async mkdir(path, { recursive = false, signal } = {}) {
    this.#assertWritable();
    const normalized = normalizePath(path);
    const result = await this.#request('mkdir', { path: normalized, recursive }, { signal, retry: false });
    this.#invalidate(normalized);
    return result;
  }

  async unlink(path, { recursive = false, signal } = {}) {
    this.#assertWritable();
    const normalized = normalizePath(path);
    const result = await this.#request('delete', { path: normalized, recursive }, { signal, retry: false });
    this.#invalidate(normalized);
    return result;
  }

  async rename(from, to, { signal } = {}) {
    this.#assertWritable();
    const result = await this.#request('rename', { from: normalizePath(from), to: normalizePath(to) }, { signal, retry: false });
    this.#invalidate(normalizePath(from));
    this.#invalidate(normalizePath(to));
    return result;
  }

  async copy(from, to, options = {}) {
    const data = await this.readFile(from, options);
    return this.writeFile(to, data, options);
  }

  async realpath(path, { signal } = {}) {
    const result = await this.#request('realpath', { path: normalizePath(path) }, { signal, cacheKey: `real:${normalizePath(path)}` });
    if (typeof result?.path !== 'string') throw new NumiOSError('REMOTE_PROTOCOL_ERROR', 'Remote realpath response is malformed.');
    return normalizePath(result.path);
  }

  async health({ signal } = {}) { return this.#request('health', {}, { signal, retry: false }); }

  #assertWritable() {
    if (this.readOnly) throw new NumiOSError('READ_ONLY_FILESYSTEM', 'Remote filesystem is configured read-only.');
  }

  #invalidate(path) {
    for (const key of this.cache.keys()) if (key.endsWith(`:${path}`) || key.startsWith(`read:${path}/`) || key.startsWith(`stat:${path}/`) || key.startsWith(`list:${path}`)) this.cache.delete(key);
  }

  async #request(operation, payload, { signal, cacheKey, retry = true } = {}) {
    await this.ready();
    if (cacheKey && this.cacheEnabled && this.cache.has(cacheKey)) return clone(this.cache.get(cacheKey));
    const attemptCount = retry ? Math.max(0, this.retries) + 1 : 1;
    let lastError;
    for (let attempt = 0; attempt < attemptCount; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException('Remote request timeout', 'TimeoutError')), this.timeoutMs);
      const abortParent = () => controller.abort(signal.reason || new DOMException('Aborted', 'AbortError'));
      signal?.addEventListener('abort', abortParent, { once: true });
      try {
        if (signal?.aborted) abortParent();
        const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json' });
        const token = await this.tokenProvider?.();
        if (token) headers.set('authorization', `Bearer ${token}`);
        const response = await this.fetchImpl(`${this.baseUrl}/v1/fs`, {
          method: 'POST', headers, signal: controller.signal,
          body: JSON.stringify({ protocol: 'numios-remote-fs', version: 1, operation, ...payload })
        });
        if (!response.ok) throw new NumiOSError('REMOTE_HTTP_ERROR', `Remote filesystem returned HTTP ${response.status}.`, { status: response.status });
        let envelope;
        try { envelope = await response.json(); }
        catch (error) { throw new NumiOSError('REMOTE_PROTOCOL_ERROR', 'Remote filesystem returned invalid JSON.', { cause: error.message }); }
        if (envelope?.protocol !== 'numios-remote-fs' || envelope.version !== 1 || typeof envelope.ok !== 'boolean') throw new NumiOSError('REMOTE_PROTOCOL_ERROR', 'Remote response does not match the NumiOS filesystem protocol.');
        if (!envelope.ok) throw new NumiOSError(envelope.error?.code || 'REMOTE_OPERATION_FAILED', envelope.error?.message || 'Remote operation failed.');
        if (cacheKey && this.cacheEnabled) this.cache.set(cacheKey, clone(envelope.data));
        return envelope.data;
      } catch (error) {
        if (controller.signal.aborted) {
          if (signal?.aborted) throw new NumiOSError('CANCELLED', 'Remote filesystem request was cancelled.');
          lastError = new NumiOSError('REMOTE_TIMEOUT', 'Remote filesystem request timed out.');
        } else if (error instanceof NumiOSError) {
          if (['REMOTE_HTTP_ERROR', 'REMOTE_PROTOCOL_ERROR', 'REMOTE_OPERATION_FAILED'].includes(error.code)) throw error;
          lastError = error;
        } else {
          lastError = new NumiOSError('REMOTE_UNREACHABLE', 'Remote filesystem could not be reached. The cause may be CORS, network failure, or an invalid server.', { cause: error.message });
        }
        if (attempt + 1 < attemptCount) await delay(Math.min(1000, 100 * (2 ** attempt)), signal);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortParent);
      }
    }
    throw lastError || new NumiOSError('REMOTE_UNREACHABLE', 'Remote filesystem request failed.');
  }
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  throw new NumiOSError('INVALID_ARGUMENT', 'Remote writes require text or bytes.');
}
function encodeBase64(bytes) { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function decodeBase64(value) { const binary = atob(value); return Uint8Array.from(binary, char => char.charCodeAt(0)); }
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new NumiOSError('CANCELLED', 'Remote filesystem request was cancelled.'));
    };
    if (signal?.aborted) { reject(new NumiOSError('CANCELLED', 'Remote filesystem request was cancelled.')); return; }
    timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

assertFilesystemContract(RemoteFileSystem.prototype);
