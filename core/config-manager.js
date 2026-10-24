import { EventHub } from './events.js';
import { NumiOSError } from './errors.js';
import { validateSchema } from './schema.js';

export class ConfigManager {
  constructor({ store, events = new EventHub(), logger = null, migrations = {} } = {}) {
    this.store = store;
    this.events = events;
    this.logger = logger;
    this.migrations = migrations;
    this.schemas = new Map();
    this.cache = new Map();
  }

  async load(name, defaults, { schema = null, currentVersion = 1, migrate = null, readOnly = false } = {}) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new NumiOSError('CONFIG_NAME_INVALID', 'Configuration name is invalid.');
    if (schema) this.schemas.set(name, schema);
    const key = `config/${name}`;
    let value = await this.store.get(key);
    if (value === undefined) {
      value = structuredCloneSafe(defaults);
      value.schemaVersion = currentVersion;
      await this.store.set(key, value);
    } else {
      if (!value || typeof value !== 'object' || !Number.isInteger(value.schemaVersion)) throw new NumiOSError('CONFIG_INVALID', 'Stored configuration is malformed.', { name });
      if (value.schemaVersion > currentVersion) throw new NumiOSError('CONFIG_VERSION_NEWER', 'Stored configuration was written by a newer NumiOS version.', { name, version: value.schemaVersion, currentVersion });
      if (value.schemaVersion < currentVersion) {
        const migration = migrate || this.migrations[name];
        if (typeof migration !== 'function') throw new NumiOSError('CONFIG_MIGRATION_MISSING', 'No configuration migration is registered.', { name, from: value.schemaVersion, to: currentVersion });
        value = await migration(structuredCloneSafe(value), value.schemaVersion, currentVersion);
        value.schemaVersion = currentVersion;
        await this.store.set(key, value);
      }
    }
    if (schema) validateConfig(value, schema, name);
    const record = { name, value: structuredCloneSafe(value), readOnly: Boolean(readOnly), loadedAt: new Date().toISOString() };
    this.cache.set(name, record);
    return structuredCloneSafe(record.value);
  }

  async get(name) {
    if (!this.cache.has(name)) throw new NumiOSError('CONFIG_NOT_LOADED', 'Configuration has not been loaded.', { name });
    return structuredCloneSafe(this.cache.get(name).value);
  }

  async update(name, updater, { expectedVersion = undefined } = {}) {
    const record = this.cache.get(name);
    if (!record) throw new NumiOSError('CONFIG_NOT_LOADED', 'Configuration has not been loaded.', { name });
    if (record.readOnly) throw new NumiOSError('CONFIG_READ_ONLY', 'This configuration is read-only.');
    return this.#withLock(name, async () => {
      const current = await this.store.get(`config/${name}`);
      if (expectedVersion !== undefined && current.schemaVersion !== expectedVersion) throw new NumiOSError('CONFIG_CONFLICT', 'Configuration changed since it was read.', { expectedVersion, actualVersion: current.schemaVersion });
      const next = await updater(structuredCloneSafe(current));
      if (!next || typeof next !== 'object' || Array.isArray(next)) throw new NumiOSError('CONFIG_INVALID', 'Configuration update must return an object.');
      next.schemaVersion = current.schemaVersion;
      const schema = this.schemas.get(name);
      if (schema) validateConfig(next, schema, name);
      await this.store.set(`config/${name}`, next);
      record.value = structuredCloneSafe(next);
      record.loadedAt = new Date().toISOString();
      this.events.emit('config.reload', { name, schemaVersion: next.schemaVersion });
      await this.logger?.info('config', 'Configuration updated.', { eventCode: 'CONFIG_UPDATED', name, schemaVersion: next.schemaVersion });
      return structuredCloneSafe(next);
    });
  }

  async reload(name) {
    const current = await this.store.get(`config/${name}`);
    if (current === undefined) throw new NumiOSError('CONFIG_NOT_FOUND', 'Configuration record does not exist.', { name });
    const schema = this.schemas.get(name);
    if (schema) validateConfig(current, schema, name);
    const record = this.cache.get(name) || { name, readOnly: false };
    record.value = structuredCloneSafe(current);
    record.loadedAt = new Date().toISOString();
    this.cache.set(name, record);
    this.events.emit('config.reload', { name, schemaVersion: current.schemaVersion });
    return structuredCloneSafe(current);
  }

  list() { return [...this.cache.values()].map(record => ({ name: record.name, schemaVersion: record.value.schemaVersion, readOnly: record.readOnly, loadedAt: record.loadedAt })); }

  async #withLock(name, callback) {
    if (globalThis.navigator?.locks?.request) return navigator.locks.request(`numios:config:${name}`, callback);
    return callback();
  }
}

function validateConfig(value, schema, name) {
  if (schema?.type) {
    try { return validateSchema(value, schema); }
    catch (error) { throw new NumiOSError('CONFIG_INVALID', `Configuration '${name}' failed schema validation.`, { cause: error.message, details: error.details }); }
  }
  const allowed = new Set(Object.keys(schema));
  for (const key of Object.keys(schema)) {
    if (schema[key] === 'string' && typeof value[key] !== 'string') throw new NumiOSError('CONFIG_INVALID', `Configuration field '${key}' must be a string.`, { name });
    if (schema[key] === 'number' && typeof value[key] !== 'number') throw new NumiOSError('CONFIG_INVALID', `Configuration field '${key}' must be a number.`, { name });
    if (schema[key] === 'object' && (!value[key] || typeof value[key] !== 'object')) throw new NumiOSError('CONFIG_INVALID', `Configuration field '${key}' must be an object.`, { name });
  }
  for (const key of Object.keys(value)) if (!allowed.has(key) && key !== 'schemaVersion') throw new NumiOSError('CONFIG_INVALID', `Unknown configuration field '${key}'.`, { name });
}
function structuredCloneSafe(value) { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
