import { NumiOSError } from '../core/errors.js';

export class FilesystemSDK {
  constructor(syscalls) { this.syscalls = syscalls; }
  async open(path, options = {}) { return unwrap(await this.syscalls.call('fs.open', { path, ...options })); }
  async close(fd) { return unwrap(await this.syscalls.call('fs.close', { fd })); }
  async read(fdOrPath, options = {}) {
    const args = typeof fdOrPath === 'number' ? { fd: fdOrPath, ...options } : { path: fdOrPath, ...options };
    return unwrap(await this.syscalls.call('fs.read', args));
  }
  async readBytes(path, options = {}) { return this.read(path, { ...options, encoding: 'bytes' }); }
  async readText(path, options = {}) { return this.read(path, { ...options, encoding: 'text' }); }
  async write(fdOrPath, data, options = {}) {
    const args = { ...(typeof fdOrPath === 'number' ? { fd: fdOrPath } : { path: fdOrPath }), data, ...options };
    return unwrap(await this.syscalls.call('fs.write', args));
  }
  async writeText(path, text, options = {}) { return this.write(path, text, options); }
  async stat(path) { return unwrap(await this.syscalls.call('fs.stat', { path })); }
  async readdir(path) { return unwrap(await this.syscalls.call('fs.readdir', { path })); }
  async mkdir(path, options = {}) { return unwrap(await this.syscalls.call('fs.mkdir', { path, ...options })); }
  async unlink(path, options = {}) { return unwrap(await this.syscalls.call('fs.unlink', { path, ...options })); }
  async rename(from, to) { return unwrap(await this.syscalls.call('fs.rename', { from, to })); }
  async copy(from, to) { return unwrap(await this.syscalls.call('fs.copy', { from, to })); }
  async resolve(path) { return unwrap(await this.syscalls.call('fs.resolve', { path })); }
  async realpath(path) { return unwrap(await this.syscalls.call('fs.realpath', { path })); }
  async access(path, mode = 'read') { return unwrap(await this.syscalls.call('fs.access', { path, mode })); }
  async chmod(path, mode) { return unwrap(await this.syscalls.call('fs.chmod', { path, mode })); }
}

export function unwrap(result) {
  if (!result?.ok) throw new NumiOSError(result?.error?.code || 'SYSCALL_FAILED', result?.error?.message || 'NumiOS syscall failed.', result?.error?.details);
  return result.data;
}
