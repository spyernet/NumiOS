import { validateSchema } from '../core/schema.js';
import { MemoryStore } from '../storage/memory-store.js';
import { IndexedDBStore } from '../storage/indexeddb-store.js';
import { CrossContextCoordinator } from '../storage/coordinator.js';
import { TreeFileSystem } from '../fs/tree-filesystem.js';
import { VirtualFileSystem } from '../fs/vfs.js';
import { RemoteFileSystem } from '../fs/filesystems/remote-filesystem.js';
import { Kernel } from '../kernel/kernel.js';

const results = document.querySelector('#results');
const summary = document.querySelector('#summary');
const details = document.querySelector('#details');
const records = [];

class SkipTest extends Error {}

function assert(condition, message = 'Assertion failed.') {
  if (!condition) throw new Error(message);
}

async function rejects(action, predicate = () => true) {
  try { await action; }
  catch (error) {
    assert(predicate(error), `Unexpected rejection: ${error?.code || error?.name || 'Error'} ${error?.message || error}`);
    return error;
  }
  throw new Error('Expected the operation to reject.');
}

async function test(name, run) {
  const item = document.createElement('li');
  item.textContent = `${name} — running`;
  results.append(item);
  const record = { name, state: 'running' };
  records.push(record);
  try {
    await run();
    record.state = 'passed';
    item.className = 'passed';
    item.textContent = `${name} — passed`;
  } catch (error) {
    record.state = error instanceof SkipTest ? 'skipped' : 'failed';
    item.className = record.state;
    item.textContent = `${name} — ${record.state}${record.state === 'skipped' ? `: ${error.message}` : `: ${error.message}`}`;
    record.error = { name: error?.name, code: error?.code, message: error?.message, stack: error?.stack };
  }
  renderSummary();
}

function renderSummary() {
  const passed = records.filter(record => record.state === 'passed').length;
  const failed = records.filter(record => record.state === 'failed').length;
  const skipped = records.filter(record => record.state === 'skipped').length;
  summary.dataset.state = failed ? 'failed' : records.every(record => record.state !== 'running') ? 'passed' : 'running';
  summary.textContent = `${passed} passed, ${failed} failed, ${skipped} skipped (${records.length} total).`;
  details.textContent = JSON.stringify({
    url: location.href,
    secureContext: globalThis.isSecureContext,
    indexedDB: Boolean(globalThis.indexedDB),
    worker: typeof Worker === 'function',
    serviceWorker: Boolean(navigator.serviceWorker),
    results: records
  }, null, 2);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load ${url}: HTTP ${response.status}.`);
  return response.json();
}

await test('Configuration JSON matches its schemas', async () => {
  const files = [
    ['../etc/system.json', '../etc/schemas/system.schema.json'],
    ['../etc/security.json', '../etc/schemas/security.schema.json'],
    ['../etc/repositories.json', '../etc/schemas/repositories.schema.json'],
    ['../etc/mounts.json', '../etc/schemas/mounts.schema.json']
  ];
  for (const [configPath, schemaPath] of files) {
    const [config, schema] = await Promise.all([
      fetchJson(new URL(configPath, import.meta.url)),
      fetchJson(new URL(schemaPath, import.meta.url))
    ]);
    assert(validateSchema(config, schema), `${configPath} did not validate.`);
  }
});

await test('Tree filesystem, global VFS paths, descriptors and ownership', async () => {
  const store = new MemoryStore();
  const filesystem = new TreeFileSystem({ store, prefix: 'browser-test/root/', name: 'browser-test-root' });
  await filesystem.ready();
  const vfs = new VirtualFileSystem({ maxHandlesPerProcess: 2 });
  await vfs.mount(filesystem, '/', { allowRoot: true });
  await vfs.mkdir('/Users', { recursive: true, mode: 0o777, owner: 'demo' });
  const identity = { id: 'pid:501', processId: 501, uid: 'demo', capabilities: [] };
  const path = '/Users/test.txt';
  await vfs.writeFile(path, 'hello', { owner: 'demo', mode: 0o600 });
  const stat = await vfs.stat(path);
  assert(stat.path === path, 'stat.path must be a global virtual path.');
  const opened = await vfs.open(path, { mode: 'readwrite', identity });
  const wrongOwner = { id: 'pid:502', processId: 502, uid: 'demo', capabilities: [] };
  await rejects(vfs.read(opened.fd, { identity: wrongOwner }), error => error.code === 'BAD_FILE_DESCRIPTOR');
  await vfs.write(opened.fd, new TextEncoder().encode('H'), { offset: 0, identity });
  const bytes = await vfs.read(opened.fd, { offset: 0, length: 5, identity });
  assert(new TextDecoder().decode(bytes) === 'Hello', 'Descriptor write/read returned unexpected bytes.');
  await vfs.close(opened.fd, { identity });
  assert(vfs.handleCount() === 0, 'Closing a descriptor should release it.');
});

await test('Remote filesystem decodes protocol reads and returns stat data', async () => {
  const statData = { path: '/docs/readme.txt', type: 'file', size: 5 };
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    const data = request.operation === 'read' ? { data: btoa('hello') } : statData;
    return {
      ok: true,
      status: 200,
      json: async () => ({ protocol: 'numios-remote-fs', version: 1, ok: true, data })
    };
  };
  const filesystem = new RemoteFileSystem({ baseUrl: 'https://remote.invalid', fetchImpl, retries: 0 });
  const bytes = await filesystem.readFile('/docs/readme.txt');
  assert(new TextDecoder().decode(bytes) === 'hello', 'Remote read did not decode response data.');
  const stat = await filesystem.stat('/docs/readme.txt');
  assert(stat === statData || (stat.path === statData.path && stat.type === statData.type && stat.size === statData.size), 'Remote stat did not return the response data object.');
});

await test('Fallback coordinator aborts queued work without blocking later locks', async () => {
  const coordinator = new CrossContextCoordinator({ locks: null, channelName: `numios-test-${Date.now()}` });
  let releaseFirst;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const first = coordinator.withLock('queue', () => {
    markStarted();
    return new Promise(resolve => { releaseFirst = resolve; });
  });
  await started;
  const controller = new AbortController();
  const queued = coordinator.withLock('queue', () => 'must-not-run', { signal: controller.signal });
  controller.abort(new DOMException('test cancellation', 'AbortError'));
  await rejects(queued, error => error.name === 'AbortError');
  const later = coordinator.withLock('queue', () => 'acquired');
  releaseFirst();
  await first;
  assert(await later === 'acquired', 'A cancelled queued lock left the local queue blocked.');
  coordinator.close();
});

await test('IndexedDB data survives closing and reopening its database', async () => {
  if (!globalThis.indexedDB) throw new SkipTest('IndexedDB is unavailable in this browser context.');
  const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const databaseName = `numios-browser-test-${suffix}`;
  let first;
  let second;
  try {
    first = new IndexedDBStore({ databaseName });
    await first.ready();
    assert(first.volatile === false, 'IndexedDBStore must not report volatile storage.');
    await first.set('test/persisted', { value: 'survives-reopen', bytes: new Uint8Array([0, 1, 255]) });
    await first.close();
    second = new IndexedDBStore({ databaseName });
    await second.ready();
    const value = await second.get('test/persisted');
    assert(value?.value === 'survives-reopen', 'The record was not retained after reopening IndexedDB.');
    assert(value.bytes instanceof Uint8Array && value.bytes[2] === 255, 'IndexedDB did not preserve the structured-clone byte array.');
  } finally {
    await first?.close();
    await second?.close();
    await deleteDatabase(databaseName);
  }
});

await test('Kernel boot, syscall policy, and config validation work together', async () => {
  const load = path => fetchJson(new URL(path, import.meta.url));
  const [systemConfig, securityConfig, repositoryConfig, mountConfig, syscallTable, serviceSchema, bootConfig] = await Promise.all([
    load('../etc/system.json'), load('../etc/security.json'), load('../etc/repositories.json'), load('../etc/mounts.json'),
    load('../kernel/syscall/syscall-table.json'), load('../services/service.schema.json'), load('../boot/boot-config.json')
  ]);
  systemConfig.storage.requestPersistentStorage = false;
  const [systemSchema, securitySchema, repositoriesSchema, mountsSchema] = await Promise.all([
    load('../etc/schemas/system.schema.json'), load('../etc/schemas/security.schema.json'),
    load('../etc/schemas/repositories.schema.json'), load('../etc/schemas/mounts.schema.json')
  ]);
  const moduleUrl = new URL('../boot/bootloader.js', import.meta.url);
  const serviceDefinitions = await Promise.all(bootConfig.serviceUnits.map(path => fetchJson(new URL(path, moduleUrl))));
  const coordinator = new CrossContextCoordinator({ locks: null, channelName: `numios-kernel-test-${Date.now()}` });
  const kernel = new Kernel({
    store: new MemoryStore(), systemConfig, securityConfig, repositoryConfig, mountConfig,
    syscallTable, serviceDefinitions, serviceSchema,
    configSchemas: { system: systemSchema, security: securitySchema, repositories: repositoriesSchema, mounts: mountsSchema },
    coordinator
  });
  try {
    await kernel.initializeStorage();
    await kernel.initializeCore();
    await kernel.registerSyscalls();
    await kernel.initializeSecurity();
    await kernel.initializeProcesses();
    await kernel.mountFilesystems();
    await kernel.startServices();
    await kernel.executeTarget('default.target');
    const status = await kernel.markReady({ bootId: 'browser-test' });
    assert(status.ready && status.state === 'ready', 'Kernel did not reach ready state.');

    const info = await kernel.dispatcher.call('system.info', {}, { callerId: 'system' });
    assert(info.ok && info.data.architecture === 'browser-native-esm', 'System info syscall failed.');
    const unknown = await kernel.dispatcher.call('system.info', {}, { callerId: 'not-registered' });
    assert(!unknown.ok && unknown.error.code === 'UNAUTHORIZED_CALLER', 'Unknown syscall caller was not rejected.');

    const path = '/Users/demo/browser-test.txt';
    const write = await kernel.dispatcher.call('fs.write', { path, data: 'hello from kernel' }, { callerId: 'system' });
    assert(write.ok, `System filesystem write failed: ${write.error?.message || ''}`);
    const app = kernel.processManager.create({ caller: 'system', name: 'read-only-test', type: 'application', uid: 'demo', capabilities: ['fs.read.user'] });
    const read = await kernel.dispatcher.call('fs.read', { path, encoding: 'text' }, { callerId: `pid:${app.pid}` });
    assert(read.ok && read.data === 'hello from kernel', 'Authorized app filesystem read failed.');
    const denied = await kernel.dispatcher.call('fs.write', { path, data: 'blocked' }, { callerId: `pid:${app.pid}` });
    assert(!denied.ok && denied.error.code === 'CAPABILITY_DENIED', 'App path authorization did not fail closed.');
    await kernel.processManager.terminate(app.pid, { caller: 'system' });

    const mounted = await kernel.dispatcher.call('disk.create', { type: 'indexeddb', id: 'browser-test-disk', mountPoint: '/Volumes/browser-test-disk' }, { callerId: 'system' });
    assert(mounted.ok && mounted.data.mount.mountPoint === '/Volumes/browser-test-disk', 'Persistent virtual disk mount failed.');
    const mountConfig = await kernel.configManager.get('mounts');
    assert(mountConfig.mounts.some(entry => entry.diskId === 'browser-test-disk'), 'Runtime disk mount was not persisted in mount configuration.');
    const unmounted = await kernel.dispatcher.call('fs.unmount', { diskId: 'browser-test-disk' }, { callerId: 'system' });
    assert(unmounted.ok && !(await kernel.configManager.get('mounts')).mounts.length, 'Unmount did not update persistent mount configuration.');

    const invalidConfig = await kernel.dispatcher.call('config.update', { name: 'system', value: { schemaVersion: 1 } }, { callerId: 'system' });
    assert(!invalidConfig.ok && invalidConfig.error.code === 'CONFIG_INVALID', 'Invalid persistent config was accepted.');
  } finally {
    await kernel.shutdown({ reason: 'browser-test-complete' });
  }
});

renderSummary();

function deleteDatabase(name) {
  if (!globalThis.indexedDB) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error('Could not delete the temporary test database.'));
    request.onblocked = () => reject(new Error('Temporary test database deletion is blocked by another tab.'));
  });
}
