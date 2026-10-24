import { unwrap } from '../../sdk/filesystem-sdk.js';

export class LibLog {
  constructor(client, identity = {}) { this.client = client; this.identity = identity; }
  write(severity, subsystem, message, metadata = {}) { return this.#call('log.write', { severity, subsystem, message, metadata }); }
  trace(subsystem, message, metadata) { return this.write('trace', subsystem, message, metadata); }
  debug(subsystem, message, metadata) { return this.write('debug', subsystem, message, metadata); }
  info(subsystem, message, metadata) { return this.write('info', subsystem, message, metadata); }
  warn(subsystem, message, metadata) { return this.write('warn', subsystem, message, metadata); }
  error(subsystem, message, metadata) { return this.write('error', subsystem, message, metadata); }
  query(options = {}) { return this.#call('log.query', options); }
  async #call(name, args) { return unwrap(await this.client.call(name, args)); }
}
