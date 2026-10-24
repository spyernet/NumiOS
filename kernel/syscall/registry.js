import { NumiOSError } from '../../core/errors.js';

const SUPPORTED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

export class SyscallRegistry {
  constructor(table) {
    if (!table || table.version !== 1 || !table.syscalls || typeof table.syscalls !== 'object') throw new NumiOSError('SYSCALL_TABLE_INVALID', 'Syscall table must be version 1 JSON.');
    this.tableVersion = table.version;
    this.definitions = new Map(Object.entries(table.syscalls));
    this.handlers = new Map();
    this.sealed = false;
    for (const [name, definition] of this.definitions) {
      if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/.test(name) || !definition?.schema || !definition.capability) throw new NumiOSError('SYSCALL_TABLE_INVALID', `Invalid syscall definition: ${name}`);
      assertSchemaDefinition(definition.schema, name);
    }
  }

  register(name, handler) {
    if (this.sealed) throw new NumiOSError('SYSCALL_REGISTRY_SEALED', 'Kernel syscall registry is immutable after initialization.');
    if (!this.definitions.has(name)) throw new NumiOSError('SYSCALL_NOT_DECLARED', 'Syscall is not declared in the system table.', { name });
    if (this.handlers.has(name)) throw new NumiOSError('SYSCALL_ALREADY_REGISTERED', 'Syscall handler is already registered.', { name });
    if (typeof handler !== 'function') throw new NumiOSError('INVALID_ARGUMENT', 'Syscall handler must be a function.');
    this.handlers.set(name, handler);
  }

  seal() {
    const missing = [...this.definitions.keys()].filter(name => !this.handlers.has(name));
    if (missing.length) throw new NumiOSError('SYSCALL_HANDLER_MISSING', 'Not all declared syscalls have kernel handlers.', { missing });
    this.sealed = true;
  }

  get(name) {
    const definition = this.definitions.get(name);
    const handler = this.handlers.get(name);
    return definition && handler ? { definition, handler } : null;
  }

  list() {
    return [...this.definitions.entries()].map(([name, definition]) => ({ name, capability: definition.capability, cancellable: Boolean(definition.cancellable), version: this.tableVersion })).sort((a, b) => a.name.localeCompare(b.name));
  }
}

function assertSchemaDefinition(schema, name) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new NumiOSError('SYSCALL_TABLE_INVALID', `Schema for ${name} must be an object.`);
  if (schema.type) for (const type of (Array.isArray(schema.type) ? schema.type : [schema.type])) if (!SUPPORTED_TYPES.has(type)) throw new NumiOSError('SYSCALL_TABLE_INVALID', `Schema for ${name} uses unsupported type ${type}.`);
  if (schema.properties) for (const child of Object.values(schema.properties)) assertSchemaDefinition(child, name);
  if (schema.items) assertSchemaDefinition(schema.items, name);
  if (schema.oneOf) for (const child of schema.oneOf) assertSchemaDefinition(child, name);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') assertSchemaDefinition(schema.additionalProperties, name);
}
