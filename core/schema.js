import { NumiOSError } from './errors.js';

const types = {
  object: value => value !== null && typeof value === 'object' && !Array.isArray(value),
  array: Array.isArray,
  string: value => typeof value === 'string',
  number: value => typeof value === 'number' && Number.isFinite(value),
  integer: value => Number.isSafeInteger(value),
  boolean: value => typeof value === 'boolean',
  null: value => value === null
};

export function validateSchema(value, schema, path = '$') {
  if (!schema || typeof schema !== 'object') throw new NumiOSError('SCHEMA_INVALID', 'Schema must be an object.');
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(candidate => {
      try { validateSchema(value, candidate, path); return true; } catch { return false; }
    });
    if (matches.length !== 1) throw new NumiOSError('VALIDATION_ERROR', `${path} must match exactly one allowed schema.`);
    return true;
  }
  if (schema.enum && !schema.enum.some(candidate => Object.is(candidate, value))) {
    throw new NumiOSError('VALIDATION_ERROR', `${path} must be one of the permitted values.`, { allowed: schema.enum });
  }
  if (schema.const !== undefined && !Object.is(schema.const, value)) {
    throw new NumiOSError('VALIDATION_ERROR', `${path} has an unexpected value.`);
  }
  if (schema.type) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = expected.some(type => types[type]?.(value));
    if (!matches) throw new NumiOSError('VALIDATION_ERROR', `${path} must be ${expected.join(' or ')}.`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new NumiOSError('VALIDATION_ERROR', `${path} is too short.`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new NumiOSError('VALIDATION_ERROR', `${path} is too long.`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) throw new NumiOSError('VALIDATION_ERROR', `${path} has an invalid format.`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) throw new NumiOSError('VALIDATION_ERROR', `${path} is below its minimum.`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new NumiOSError('VALIDATION_ERROR', `${path} exceeds its maximum.`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new NumiOSError('VALIDATION_ERROR', `${path} has too few items.`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new NumiOSError('VALIDATION_ERROR', `${path} has too many items.`);
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`));
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) {
      throw new NumiOSError('VALIDATION_ERROR', `${path} contains duplicate items.`);
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const required = schema.required || [];
    for (const key of required) if (!Object.hasOwn(value, key)) throw new NumiOSError('VALIDATION_ERROR', `${path}.${key} is required.`);
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) validateSchema(child, schema.properties[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new NumiOSError('VALIDATION_ERROR', `${path}.${key} is not allowed.`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateSchema(child, schema.additionalProperties, `${path}.${key}`);
    }
  }
  return true;
}

export function parseJson(text, label = 'JSON') {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new NumiOSError('JSON_INVALID', `${label} is not valid JSON.`, { cause: error.message });
  }
}
