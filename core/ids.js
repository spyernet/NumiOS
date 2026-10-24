let fallbackSequence = 0;

export function createId(prefix = 'id') {
  const cryptoApi = globalThis.crypto;
  const random = cryptoApi?.randomUUID?.() || `${Date.now().toString(36)}-${(++fallbackSequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

export function createRequestId() {
  return createId('req');
}
