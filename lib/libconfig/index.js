import { NumiOSError } from '../../core/errors.js';
import { unwrap } from '../../sdk/filesystem-sdk.js';

export class LibConfig {
  constructor(client, prefix) { this.client = client; this.prefix = prefix; }
  async read(name) {
    const path = this.#path(name);
    const text = unwrap(await this.client.call('fs.read', { path, encoding: 'text' }));
    try { return JSON.parse(text); } catch (error) { throw new NumiOSError('CONFIG_INVALID', 'Configuration file contains invalid JSON.', { path, cause: error.message }); }
  }
  async write(name, value) {
    const text = JSON.stringify(value, null, 2);
    return unwrap(await this.client.call('fs.write', { path: this.#path(name), data: text, create: true }));
  }
  #path(name) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9._-]+\.json$/.test(name)) throw new NumiOSError('INVALID_ARGUMENT', 'Configuration name must be a simple .json filename.');
    return `${this.prefix.replace(/\/$/, '')}/${name}`;
  }
}
