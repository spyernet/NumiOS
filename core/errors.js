export class NumiOSError extends Error {
  constructor(code, message, details = undefined, options = undefined) {
    super(message, options);
    this.name = 'NumiOSError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function fail(code, message, details) {
  throw new NumiOSError(code, message, details);
}

export function toErrorObject(error) {
  if (error instanceof NumiOSError) {
    return { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  }
  if (error?.name === 'AbortError') return { code: 'CANCELLED', message: 'The operation was cancelled.' };
  return { code: 'INTERNAL_ERROR', message: error?.message || 'An internal error occurred.' };
}

export function resultOk(data = null, requestId = null) {
  return { ok: true, data, error: null, requestId };
}

export function resultError(error, requestId = null) {
  return { ok: false, data: null, error: toErrorObject(error), requestId };
}

export function assert(condition, code, message, details) {
  if (!condition) fail(code, message, details);
}

export function asNumiOSError(error, fallbackCode = 'INTERNAL_ERROR') {
  if (error instanceof NumiOSError) return error;
  if (error?.name === 'AbortError') return new NumiOSError('CANCELLED', 'The operation was cancelled.');
  return new NumiOSError(fallbackCode, error?.message || 'An internal error occurred.');
}
