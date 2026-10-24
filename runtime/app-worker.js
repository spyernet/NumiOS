import { SyscallClient, createApplicationSDK } from '../sdk/index.js';

let initialized = false;
let suspended = false;
let checkpointWaiters = [];
let client = null;

self.addEventListener('message', event => {
  const message = event.data;
  if (message?.type === 'numios:suspend') {
    suspended = true;
    self.postMessage({ type: 'numios:suspended' });
  } else if (message?.type === 'numios:resume') {
    suspended = false;
    for (const resolve of checkpointWaiters.splice(0)) resolve();
    self.postMessage({ type: 'numios:resumed' });
  } else if (message?.type === 'numios:init' && !initialized) {
    initialized = true;
    void startApplication(message);
  }
});

async function startApplication(message) {
  try {
    if (!message.syscallPort || typeof message.entryUrl !== 'string') throw new Error('Invalid application worker initialization message.');
    client = new SyscallClient(message.syscallPort);
    const sdk = createApplicationSDK(client, {
      pid: message.pid,
      applicationId: message.applicationId,
      name: message.name,
      checkpoint: async () => {
        while (suspended) await new Promise(resolve => checkpointWaiters.push(resolve));
      }
    });
    const module = await import(message.entryUrl);
    if (typeof module.main !== 'function') throw new Error('Application entry module must export async function main(sdk, context).');
    self.postMessage({ type: 'numios:started', pid: message.pid, applicationId: message.applicationId });
    const code = await module.main(sdk, { args: message.args || [], env: message.env || {}, pid: message.pid, applicationId: message.applicationId });
    self.postMessage({ type: 'numios:exit', pid: message.pid, exitCode: Number.isInteger(code) ? code : 0 });
  } catch (error) {
    self.postMessage({ type: 'numios:failure', pid: message.pid, error: { name: error.name, code: error.code || 'APP_RUNTIME_ERROR', message: error.message || String(error) } });
  } finally {
    client?.close();
  }
}
