import { unwrap } from '../../sdk/filesystem-sdk.js';

export class LibIPC {
  constructor(client) { this.client = client; }
  create(options) { return this.#call('ipc.create', options || {}); }
  send(channelId, message) { return this.#call('ipc.send', { channelId, message }); }
  receive(channelId, options = {}) { return this.#call('ipc.receive', { channelId, ...options }); }
  subscribe(channelId) { return this.#call('ipc.subscribe', { channelId }); }
  unsubscribe(channelId, subscriptionId) { return this.#call('ipc.unsubscribe', { channelId, subscriptionId }); }
  close(channelId) { return this.#call('ipc.close', { channelId }); }
  async #call(name, args) { return unwrap(await this.client.call(name, args)); }
}
