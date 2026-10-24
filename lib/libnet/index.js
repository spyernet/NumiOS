import { unwrap } from '../../sdk/filesystem-sdk.js';

export class LibNet {
  constructor(client) { this.client = client; }
  async request(options) { return unwrap(await this.client.call('network.request', options)); }
  async get(url, options = {}) { return this.request({ ...options, url, method: 'GET' }); }
  async post(url, body, options = {}) { return this.request({ ...options, url, method: 'POST', body }); }
}
