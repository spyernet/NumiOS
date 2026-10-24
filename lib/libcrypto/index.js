import { NumiOSError } from '../../core/errors.js';

export async function sha256(data) {
  if (!globalThis.crypto?.subtle) throw new NumiOSError('API_UNAVAILABLE', 'Web Crypto subtle API is unavailable.');
  let bytes;
  if (typeof data === 'string') bytes = new TextEncoder().encode(data);
  else if (data instanceof Uint8Array) bytes = data;
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else throw new NumiOSError('INVALID_ARGUMENT', 'sha256 expects text or bytes.');
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
