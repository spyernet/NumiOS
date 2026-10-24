import { NumiOSError } from '../core/errors.js';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

export class NetworkClient {
  constructor({ fetchImpl = globalThis.fetch, maxResponseBytes = 16 * 1024 * 1024, defaultTimeoutMs = 15000 } = {}) {
    this.fetchImpl = fetchImpl;
    this.maxResponseBytes = maxResponseBytes;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  async request({ url, method = 'GET', headers = {}, body = undefined, timeoutMs = this.defaultTimeoutMs, cache = 'default', signal = undefined, responseType = 'bytes' } = {}) {
    if (typeof this.fetchImpl !== 'function') throw new NumiOSError('NETWORK_UNAVAILABLE', 'Fetch API is unavailable in this browser.');
    let parsed;
    try { parsed = new URL(url, globalThis.location?.href); } catch { throw new NumiOSError('INVALID_ARGUMENT', 'Network URL is invalid.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new NumiOSError('NETWORK_URL_DENIED', 'Only credential-free HTTP(S) URLs are supported.');
    const normalizedMethod = String(method).toUpperCase();
    if (!METHODS.has(normalizedMethod)) throw new NumiOSError('NETWORK_METHOD_DENIED', 'HTTP method is not supported by the browser network adapter.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new NumiOSError('INVALID_ARGUMENT', 'Network timeout must be between 1 and 120000 milliseconds.');
    if (!['default', 'no-store', 'reload', 'force-cache'].includes(cache)) throw new NumiOSError('INVALID_ARGUMENT', 'Unsupported browser cache mode.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Network timeout', 'TimeoutError')), timeoutMs);
    const onAbort = () => controller.abort(signal.reason || new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal?.aborted) onAbort();
      let response;
      try {
        response = await this.fetchImpl(parsed.href, {
          method: normalizedMethod, headers: normalizeHeaders(headers), body: body === undefined ? undefined : normalizeBody(body),
          cache, credentials: 'omit', redirect: 'follow', referrerPolicy: 'strict-origin-when-cross-origin', signal: controller.signal
        });
      } catch (error) {
        if (controller.signal.aborted) {
          if (signal?.aborted) throw new NumiOSError('CANCELLED', 'Network request was cancelled.');
          throw new NumiOSError('NETWORK_TIMEOUT', 'Network request timed out.');
        }
        throw new NumiOSError('NETWORK_CORS_OR_UNREACHABLE', 'Network request failed; browser CORS or connectivity policy may have blocked it.', { url: parsed.origin, cause: error.message });
      }
      const responseHeaders = {};
      for (const [key, value] of response.headers.entries()) responseHeaders[key.toLowerCase()] = value;
      let responseBody = new Uint8Array();
      if (normalizedMethod !== 'HEAD' && response.body) responseBody = await readBounded(response.body, this.maxResponseBytes, controller.signal);
      if (responseType === 'text') responseBody = new TextDecoder().decode(responseBody);
      else if (responseType !== 'bytes') throw new NumiOSError('INVALID_ARGUMENT', 'Response type must be bytes or text.');
      return { status: response.status, statusText: response.statusText, ok: response.ok, url: response.url, headers: responseHeaders, body: responseBody };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

function normalizeHeaders(headers) {
  const result = new Headers();
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers || {});
  for (const [name, value] of entries) {
    if (/^(cookie|host|origin|referer|content-length)$/i.test(name)) continue;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(String(value))) throw new NumiOSError('INVALID_ARGUMENT', 'HTTP header is invalid.');
    result.set(name, String(value));
  }
  return result;
}
function normalizeBody(body) {
  if (typeof body === 'string' || body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof URLSearchParams || body instanceof FormData) return body;
  throw new NumiOSError('INVALID_ARGUMENT', 'Network request body must be text, bytes, FormData, Blob, or URLSearchParams.');
}
async function readBounded(stream, limit, signal) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new NumiOSError('RESOURCE_LIMIT', 'Network response exceeded the configured response size limit.', { limit });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
