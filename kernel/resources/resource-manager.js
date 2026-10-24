import { createId } from '../../core/ids.js';
import { NumiOSError } from '../../core/errors.js';

export class ResourceManager {
  constructor({ maxProcesses = 256, maxLogicalMemoryBytes = 256 * 1024 * 1024, maxHandlesPerProcess = 256, scheduler = null } = {}) {
    this.maxProcesses = maxProcesses;
    this.maxLogicalMemoryBytes = maxLogicalMemoryBytes;
    this.maxHandlesPerProcess = maxHandlesPerProcess;
    this.scheduler = scheduler;
    this.leases = new Map();
    this.processLimits = new Map();
  }

  setProcessLimits(pid, limits = {}) {
    const normalized = {
      memoryBytes: safeLimit(limits.memoryBytes, this.maxLogicalMemoryBytes),
      handles: safeLimit(limits.handles, this.maxHandlesPerProcess),
      timeoutMs: safeLimit(limits.timeoutMs, 60000)
    };
    this.processLimits.set(pid, normalized);
    return { ...normalized };
  }

  allocate(pid, bytes, { label = 'logical-memory' } = {}) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new NumiOSError('INVALID_ARGUMENT', 'Logical memory allocation size must be a non-negative safe integer.');
    const current = this.usage(pid).logicalMemoryBytes;
    const limits = this.processLimits.get(pid) || { memoryBytes: this.maxLogicalMemoryBytes };
    if (current + bytes > Math.min(limits.memoryBytes, this.maxLogicalMemoryBytes)) throw new NumiOSError('RESOURCE_LIMIT', 'Logical memory quota exceeded.', { pid, current, request: bytes, limit: limits.memoryBytes });
    const id = createId('mem');
    this.leases.set(id, { id, pid, bytes, label, allocatedAt: new Date().toISOString() });
    return { ...this.leases.get(id) };
  }

  release(id, pid = undefined) {
    const lease = this.leases.get(id);
    if (!lease) return false;
    if (pid !== undefined && lease.pid !== pid) throw new NumiOSError('RESOURCE_OWNERSHIP_DENIED', 'Logical memory lease belongs to a different process.');
    this.leases.delete(id);
    return true;
  }

  releaseProcess(pid) {
    let released = 0;
    for (const [id, lease] of this.leases) if (lease.pid === pid) { this.leases.delete(id); released += 1; }
    this.processLimits.delete(pid);
    return released;
  }

  limit(pid, resource, value) {
    if (!['memoryBytes', 'handles', 'timeoutMs'].includes(resource)) throw new NumiOSError('INVALID_ARGUMENT', 'Unknown logical resource limit.');
    if (!Number.isSafeInteger(value) || value < 0) throw new NumiOSError('INVALID_ARGUMENT', 'Resource limit must be a non-negative safe integer.');
    const current = this.processLimits.get(pid) || { memoryBytes: this.maxLogicalMemoryBytes, handles: this.maxHandlesPerProcess, timeoutMs: 60000 };
    current[resource] = value;
    this.processLimits.set(pid, current);
    return { ...current };
  }

  usage(pid = undefined) {
    let logicalMemoryBytes = 0;
    let allocations = 0;
    for (const lease of this.leases.values()) {
      if (pid === undefined || lease.pid === pid) { logicalMemoryBytes += lease.bytes; allocations += 1; }
    }
    return { logicalMemoryBytes, allocations, activeTasks: this.scheduler?.status().active ?? 0, queuedTasks: this.scheduler?.status().queued ?? 0, processId: pid ?? null, physicalMemoryAvailable: false };
  }

  systemUsage(processCount = 0) {
    return { ...this.usage(), processCount, processLimit: this.maxProcesses, logicalMemoryLimitBytes: this.maxLogicalMemoryBytes, physicalMemoryAvailable: false };
  }
}

function safeLimit(value, fallback) { return Number.isSafeInteger(value) && value >= 0 ? value : fallback; }
