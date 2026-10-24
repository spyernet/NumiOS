import { ApplicationSDK } from './application-sdk.js';
import { unwrap } from './filesystem-sdk.js';

export class ServiceSDK extends ApplicationSDK {
  constructor(options) {
    super(options);
    this.services = Object.freeze({
      status: name => this.call('service.status', { name }),
      list: () => this.call('service.list', {}),
      logs: (name, limit = 100) => this.call('service.logs', { name, limit })
    });
    Object.freeze(this);
  }
}

export function createServiceSDK(client, identity = {}) { return new ServiceSDK({ client, identity }); }
