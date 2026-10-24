import { Bootloader } from './bootloader.js';

const stateNode = document.querySelector('[data-numios-state]');
const outputNode = document.querySelector('[data-numios-diagnostics]');
const bootloader = new Bootloader({ onProgress: renderProgress });

function appendLine(message) {
  if (!outputNode) return;
  outputNode.textContent += `${message}\n`;
  outputNode.scrollTop = outputNode.scrollHeight;
}

function renderProgress(progress) {
  const state = `${progress.stage}: ${progress.stageState}${progress.attempt > 1 ? ` (attempt ${progress.attempt})` : ''}`;
  if (stateNode) stateNode.textContent = state;
  if (progress.stageState === 'running' || progress.stageState === 'complete' || progress.stageState === 'failed') appendLine(`${new Date(progress.timestamp).toLocaleTimeString()}  ${state}`);
}

try {
  const result = await bootloader.start();
  window.numios = bootloader.api();
  if (stateNode) stateNode.textContent = result.state === 'ready' ? (result.recoveryMode ? 'Ready (recovery mode)' : 'Ready') : 'Recovery required';
  appendLine(`NumiOS ${result.state}; boot id ${result.bootId}.`);
  if (result.error) appendLine(`Boot error ${result.error.code} at ${result.error.stage}: ${result.error.message}`);
  for (const warning of bootloader.warnings) appendLine(`Warning: ${warning}`);
  if (result.kernel) appendLine(`Kernel ${result.kernel.kernelId} · ${result.kernel.mounts.length} mounts · ${result.kernel.syscalls?.count || 0} syscalls`);
  appendLine('Programmatic control API: window.numios');
  window.dispatchEvent(new CustomEvent('numios:booted', { detail: result }));
} catch (error) {
  if (stateNode) stateNode.textContent = 'Boot failed';
  appendLine(`${error.code || error.name || 'BOOT_FAILED'}: ${error.message}`);
  appendLine('NumiOS requires a secure HTTP(S) static origin and persistent browser storage. No backend server is used.');
  window.dispatchEvent(new CustomEvent('numios:boot-error', { detail: { code: error.code || 'BOOT_FAILED', message: error.message } }));
}
