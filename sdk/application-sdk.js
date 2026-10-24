import { FilesystemSDK } from './filesystem-sdk.js';
import { unwrap } from './filesystem-sdk.js';
import { NumiOSError } from '../core/errors.js';

export class ApplicationSDK {
  constructor({ client, identity = {} } = {}) {
    this.client = client;
    this.identity = Object.freeze({ pid: identity.pid ?? null, applicationId: identity.applicationId ?? null, name: identity.name ?? 'application' });
    this.fs = new FilesystemSDK(client);
    this.system = Object.freeze({
      info: () => call(client, 'system.info', {}),
      status: () => call(client, 'system.status', {})
    });
    this.process = Object.freeze({
      get pid() { return identity.pid ?? null; },
      list: options => call(client, 'process.list', options || {}),
      wait: (pid, options = {}) => call(client, 'process.wait', { pid, ...options }),
      signal: (pid, signal) => call(client, 'process.signal', { pid, signal }),
      checkpoint: () => identity.checkpoint?.() || Promise.resolve()
    });
    this.ipc = Object.freeze({
      create: options => call(client, 'ipc.create', options || {}),
      send: (channelId, message) => call(client, 'ipc.send', { channelId, message }),
      receive: (channelId, options = {}) => call(client, 'ipc.receive', { channelId, ...options }),
      subscribe: channelId => call(client, 'ipc.subscribe', { channelId }),
      unsubscribe: (channelId, subscriptionId) => call(client, 'ipc.unsubscribe', { channelId, subscriptionId }),
      close: channelId => call(client, 'ipc.close', { channelId })
    });
    this.network = Object.freeze({ request: options => call(client, 'network.request', options) });
    this.packages = Object.freeze({ query: id => call(client, 'package.query', { id }), list: options => call(client, 'package.list', options || {}) });
    this.repository = Object.freeze({ list: () => call(client, 'repository.list', {}), query: (packageId, range = '*') => call(client, 'repository.query', { packageId, range }), refresh: id => call(client, 'repository.refresh', id ? { id } : {}) });
    this.log = Object.freeze({
      write: (severity, subsystem, message, metadata = {}) => call(client, 'log.write', { severity, subsystem, message, metadata }),
      query: options => call(client, 'log.query', options || {})
    });
    this.resources = Object.freeze({
      allocate: (bytes, label) => call(client, 'memory.allocate', { bytes, label }),
      release: leaseId => call(client, 'memory.release', { leaseId }),
      usage: () => call(client, 'resource.usage', { pid: identity.pid })
    });
    if (new.target === ApplicationSDK) Object.freeze(this);
  }

  async call(name, args, options) { return call(this.client, name, args, options); }
  async close() { this.client.close?.(); }
}

export function createApplicationSDK(client, identity = {}) { return new ApplicationSDK({ client, identity }); }

async function call(client, name, args, options) {
  const result = await client.call(name, args, options);
  return unwrap(result);
}
