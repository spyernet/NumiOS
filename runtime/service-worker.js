import { SyscallClient, createServiceSDK } from '../sdk/index.js';

let initialized = false;
let client = null;
let serviceHandle = null;

self.addEventListener('message', event => {
  if (event.data?.type === 'numios:init-service' && !initialized) {
    initialized = true;
    void startService(event.data);
  } else if (event.data?.type === 'numios:stop-service') {
    void stopService(event.data.reason || 'requested');
  }
});

async function startService(message) {
  try {
    if (!message.syscallPort || typeof message.entryUrl !== 'string') throw new Error('Invalid service worker initialization message.');
    client = new SyscallClient(message.syscallPort);
    const sdk = createServiceSDK(client, { pid: message.pid, serviceName: message.serviceName, name: message.serviceName });
    const module = await import(message.entryUrl);
    if (typeof module.start !== 'function') throw new Error('Service entry module must export async function start(sdk, context).');
    serviceHandle = await module.start(sdk, { pid: message.pid, serviceName: message.serviceName, config: message.config || {} });
    self.postMessage({ type: 'numios:service-ready', pid: message.pid, serviceName: message.serviceName });
  } catch (error) {
    self.postMessage({ type: 'numios:service-failure', pid: message.pid, serviceName: message.serviceName, error: { code: error.code || 'SERVICE_RUNTIME_ERROR', message: error.message || String(error) } });
  }
}

async function stopService(reason) {
  try {
    await serviceHandle?.stop?.({ reason });
    self.postMessage({ type: 'numios:service-stopped', reason });
  } catch (error) {
    self.postMessage({ type: 'numios:service-failure', error: { code: error.code || 'SERVICE_STOP_FAILED', message: error.message || String(error) } });
  } finally {
    client?.close();
    self.close();
  }
}
