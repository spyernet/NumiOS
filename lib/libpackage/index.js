import { unwrap } from '../../sdk/filesystem-sdk.js';

export class LibPackage {
  constructor(client) { this.client = client; }
  query(id) { return this.#call('package.query', { id }); }
  list(type) { return this.#call('package.list', type ? { type } : {}); }
  install(archive, options = {}) { return this.#call('package.install', { archive, ...options }); }
  remove(id, options = {}) { return this.#call('package.remove', { id, ...options }); }
  update(id) { return this.#call('package.update', id ? { id } : {}); }
  async #call(name, args) { return unwrap(await this.client.call(name, args)); }
}
