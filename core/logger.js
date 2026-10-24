import { createId } from './ids.js';
import { NumiOSError } from './errors.js';

const LEVELS = Object.freeze({ trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 });

export class Logger {
  constructor({ store = null, capacity = 2000, level = 'info', clock = () => Date.now(), events = null } = {}) {
    this.store = store;
    this.capacity = Math.max(100, capacity);
    this.level = LEVELS[level] ? level : 'info';
    this.clock = clock;
    this.events = events;
    this.records = [];
    this.sequence = 0;
    this.writeQueue = Promise.resolve();
    this.persistenceError = null;
  }

  async initialize() {
    if (!this.store) return;
    const saved = await this.store.list('logs/');
    const ordered = saved.sort((a, b) => Number(a[0].slice(5)) - Number(b[0].slice(5))).slice(-this.capacity);
    this.records = ordered.map(([, record]) => record);
    this.sequence = ordered.reduce((max, [key]) => Math.max(max, Number(key.slice(5)) || 0), 0);
    const obsolete = saved.slice(0, Math.max(0, saved.length - this.capacity)).map(([key]) => ({ type: 'delete', key }));
    if (obsolete.length) await this.store.batch(obsolete);
  }

  log(level, subsystem, message, metadata = {}, identity = 'kernel', requestId = null) {
    if (!Object.hasOwn(LEVELS, level)) throw new NumiOSError('INVALID_ARGUMENT', `Unknown log level: ${level}`);
    if (LEVELS[level] < LEVELS[this.level]) return Promise.resolve(null);
    const record = Object.freeze({
      timestamp: new Date(this.clock()).toISOString(),
      severity: level,
      subsystem: String(subsystem || 'kernel'),
      identity: String(identity || 'kernel'),
      eventCode: String(metadata?.eventCode || 'GENERAL'),
      message: String(message),
      metadata: safeMetadata(metadata),
      requestId: requestId || metadata?.requestId || createId('log')
    });
    this.records.push(record);
    if (this.records.length > this.capacity) this.records.splice(0, this.records.length - this.capacity);
    this.events?.emit('log', record);
    if (!this.store) return Promise.resolve(record);
    const sequence = ++this.sequence;
    this.writeQueue = this.writeQueue.catch(error => { this.persistenceError = error; }).then(async () => {
      try {
        await this.store.set(`logs/${String(sequence).padStart(12, '0')}`, record);
        if (sequence > this.capacity) await this.store.delete(`logs/${String(sequence - this.capacity).padStart(12, '0')}`);
      } catch (error) {
        this.persistenceError = error;
      }
    });
    return this.writeQueue.then(() => record);
  }

  trace(subsystem, message, metadata, identity) { return this.log('trace', subsystem, message, metadata, identity); }
  debug(subsystem, message, metadata, identity) { return this.log('debug', subsystem, message, metadata, identity); }
  info(subsystem, message, metadata, identity) { return this.log('info', subsystem, message, metadata, identity); }
  warn(subsystem, message, metadata, identity) { return this.log('warn', subsystem, message, metadata, identity); }
  error(subsystem, message, metadata, identity) { return this.log('error', subsystem, message, metadata, identity); }
  fatal(subsystem, message, metadata, identity) { return this.log('fatal', subsystem, message, metadata, identity); }

  query({ limit = 100, since = null, severity = null, subsystem = null, identity = null, requestId = null } = {}) {
    let result = this.records;
    if (since) result = result.filter(record => record.timestamp >= since);
    if (severity) result = result.filter(record => record.severity === severity);
    if (subsystem) result = result.filter(record => record.subsystem === subsystem);
    if (identity) result = result.filter(record => record.identity === identity);
    if (requestId) result = result.filter(record => record.requestId === requestId);
    return result.slice(-Math.max(0, Math.min(1000, limit))).map(record => ({ ...record, metadata: { ...record.metadata } }));
  }

  async flush() {
    await this.writeQueue;
    if (this.persistenceError) throw new NumiOSError('LOG_PERSISTENCE_FAILED', 'One or more structured log records could not be persisted.', { cause: this.persistenceError.message });
  }
}

function safeMetadata(metadata) {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  try {
    return JSON.parse(JSON.stringify(metadata, (_key, value) => {
      if (value instanceof Error) return { name: value.name, message: value.message, code: value.code };
      if (typeof value === 'bigint') return String(value);
      return value;
    }));
  } catch {
    return { serialization: 'metadata-unavailable' };
  }
}
