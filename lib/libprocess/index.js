import { unwrap } from '../../sdk/filesystem-sdk.js';

export class LibProcess {
  constructor(client, pid = null) { this.client = client; this.pid = pid; }
  list(options = {}) { return this.#call('process.list', options); }
  get(pid = this.pid) { return this.#call('process.get', { pid }); }
  wait(pid, options = {}) { return this.#call('process.wait', { pid, ...options }); }
  signal(pid, signal) { return this.#call('process.signal', { pid, signal }); }
  async #call(name, args) { return unwrap(await this.client.call(name, args)); }
}
