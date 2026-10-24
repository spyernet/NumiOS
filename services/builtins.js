export function createBuiltinServices({ repositoryManager, packageManager, intervalMs = 30000 } = {}) {
  let systemEventsChannel = null;
  return {
    async storage({ sdk }) {
      const result = await sdk.call('disk.list', {});
      if (!result || !Array.isArray(result.disks)) throw new Error('Storage service could not verify the disk manager.');
      return { health: () => result, stop: async () => {} };
    },
    async logging({ sdk, name }) {
      await sdk.log.write('info', 'service.logging', 'Logging service online.', { service: name, eventCode: 'LOGGING_READY' });
      return { stop: async () => { await sdk.log.write('info', 'service.logging', 'Logging service stopping.', { eventCode: 'LOGGING_STOP' }); } };
    },
    async ipc({ sdk, name }) {
      const created = await sdk.ipc.create({ name: 'numios.system.events', scope: 'system', capacity: 256 });
      systemEventsChannel = created.id;
      return {
        channelId: created.id,
        stop: async () => {
          try { await sdk.ipc.close(created.id); } finally { systemEventsChannel = null; }
        }
      };
    },
    async 'package-repositories'({ sdk }) {
      await repositoryManager?.initialize?.();
      await sdk.log.write('info', 'package.repository', 'Repository configuration loaded.', { eventCode: 'REPOSITORIES_READY', configured: repositoryManager?.list?.().length || 0 });
      return { stop: async () => {} };
    },
    async 'system-monitor'({ sdk, logger }) {
      let running = true;
      const tick = async () => {
        if (!running) return;
        const status = await sdk.system.status();
        const message = { kind: 'health-snapshot', timestamp: new Date().toISOString(), health: status.health, processes: status.processes?.length ?? null };
        if (systemEventsChannel) await sdk.ipc.send(systemEventsChannel, message);
        await logger?.debug('monitor', 'System health snapshot collected.', { eventCode: 'HEALTH_SNAPSHOT', health: status.health });
      };
      const timer = setInterval(() => { void tick().catch(error => logger?.warn('monitor', 'Health snapshot failed.', { eventCode: 'HEALTH_SNAPSHOT_FAILED', error: error.message })); }, intervalMs);
      return { tick, stop: async () => { running = false; clearInterval(timer); } };
    }
  };
}
