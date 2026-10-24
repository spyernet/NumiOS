import { unwrap } from '../../sdk/filesystem-sdk.js';

export class LibSys {
  constructor(client) { this.client = client; }
  async call(name, args, options) { return unwrap(await this.client.call(name, args, options)); }
  info() { return this.call('system.info', {}); }
  status() { return this.call('system.status', {}); }
  shutdown(reason = 'requested') { return this.call('system.shutdown', { reason }); }
  reboot() { return this.call('system.reboot', {}); }
  syscalls() { return this.call('syscall.list', {}); }
}
