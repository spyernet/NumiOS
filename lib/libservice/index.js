import { unwrap } from '../../sdk/filesystem-sdk.js';

export class LibService {
  constructor(client) { this.client = client; }
  status(name) { return this.#call('service.status', { name }); }
  list() { return this.#call('service.list', {}); }
  logs(name, limit = 100) { return this.#call('service.logs', { name, limit }); }
  async #call(name, args) { return unwrap(await this.client.call(name, args)); }
}
