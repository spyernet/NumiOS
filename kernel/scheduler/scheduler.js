import { NumiOSError } from '../../core/errors.js';
import { createId } from '../../core/ids.js';

export class Scheduler {
  constructor({ concurrency = 4, maxQueue = 1000, agingIntervalMs = 1000, defaultBudgetMs = 10000, clock = () => Date.now(), events = null } = {}) {
    this.concurrency = Math.max(1, Math.floor(concurrency));
    this.maxQueue = maxQueue;
    this.agingIntervalMs = agingIntervalMs;
    this.defaultBudgetMs = defaultBudgetMs;
    this.clock = clock;
    this.events = events;
    this.queue = [];
    this.active = new Map();
    this.closed = false;
  }

  schedule(task, { priority = 0, timeoutMs = this.defaultBudgetMs, signal = undefined, identity = 'process', label = 'task' } = {}) {
    if (this.closed) return Promise.reject(new NumiOSError('SCHEDULER_STOPPED', 'Scheduler is shutting down.'));
    if (typeof task !== 'function') return Promise.reject(new NumiOSError('INVALID_ARGUMENT', 'Scheduled workload must be a function.'));
    if (this.queue.length >= this.maxQueue) return Promise.reject(new NumiOSError('RESOURCE_LIMIT', 'Scheduler queue is full.'));
    if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      const job = { id: createId('job'), task, priority: boundedPriority(priority), timeoutMs, signal, identity, label, enqueuedAt: this.clock(), resolve, reject };
      this.queue.push(job);
      this.events?.emit('scheduler.queued', publicJob(job));
      this.#pump();
    });
  }

  async #pump() {
    while (!this.closed && this.active.size < this.concurrency && this.queue.length) {
      const now = this.clock();
      this.queue.sort((a, b) => effectivePriority(b, now, this.agingIntervalMs) - effectivePriority(a, now, this.agingIntervalMs) || a.enqueuedAt - b.enqueuedAt);
      const job = this.queue.shift();
      if (job.signal?.aborted) { job.reject(job.signal.reason || new DOMException('Aborted', 'AbortError')); continue; }
      this.#run(job);
    }
  }

  async #run(job) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(job.signal.reason || new DOMException('Aborted', 'AbortError'));
    job.signal?.addEventListener('abort', onAbort, { once: true });
    const startedAt = this.clock();
    const record = { ...job, controller, startedAt };
    this.active.set(job.id, record);
    this.events?.emit('scheduler.started', publicJob(record));
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        if (Number.isFinite(job.timeoutMs) && job.timeoutMs > 0) timer = setTimeout(() => {
          controller.abort(new NumiOSError('EXECUTION_BUDGET_EXCEEDED', 'Cooperative task exceeded its execution budget.', { timeoutMs: job.timeoutMs }));
          reject(new NumiOSError('EXECUTION_BUDGET_EXCEEDED', 'Cooperative task exceeded its execution budget.', { timeoutMs: job.timeoutMs }));
        }, job.timeoutMs);
      });
      const work = Promise.resolve().then(() => job.task({ signal: controller.signal, jobId: job.id }));
      const result = Number.isFinite(job.timeoutMs) && job.timeoutMs > 0 ? await Promise.race([work, timeout]) : await work;
      if (controller.signal.aborted) throw controller.signal.reason || new DOMException('Aborted', 'AbortError');
      job.resolve(result);
      this.events?.emit('scheduler.completed', { ...publicJob(record), elapsedMs: this.clock() - startedAt });
    } catch (error) {
      job.reject(error instanceof NumiOSError ? error : error?.name === 'AbortError' ? error : new NumiOSError('TASK_FAILED', error?.message || 'Scheduled task failed.'));
      this.events?.emit('scheduler.failed', { ...publicJob(record), elapsedMs: this.clock() - startedAt, error: { code: error.code || 'TASK_FAILED', message: error.message } });
    } finally {
      clearTimeout(timer);
      job.signal?.removeEventListener('abort', onAbort);
      this.active.delete(job.id);
      this.#pump();
    }
  }

  cancel(jobId, reason = 'Scheduler job cancelled.') {
    const index = this.queue.findIndex(job => job.id === jobId);
    if (index >= 0) {
      const [job] = this.queue.splice(index, 1);
      job.reject(new NumiOSError('CANCELLED', reason));
      return true;
    }
    const active = this.active.get(jobId);
    if (active) { active.controller.abort(new NumiOSError('CANCELLED', reason)); return true; }
    return false;
  }

  status() { return { queued: this.queue.length, active: this.active.size, concurrency: this.concurrency, stopped: this.closed }; }

  async shutdown({ cancelQueued = true } = {}) {
    this.closed = true;
    if (cancelQueued) for (const job of this.queue.splice(0)) job.reject(new NumiOSError('CANCELLED', 'Scheduler is shutting down.'));
    for (const record of this.active.values()) record.controller.abort(new NumiOSError('CANCELLED', 'Scheduler is shutting down.'));
    await Promise.allSettled([...this.active.values()].map(record => record.promise).filter(Boolean));
  }
}

function boundedPriority(value) { return Number.isFinite(value) ? Math.max(-20, Math.min(20, Math.trunc(value))) : 0; }
function effectivePriority(job, now, agingMs) { return job.priority + Math.floor((now - job.enqueuedAt) / Math.max(1, agingMs)); }
function publicJob(job) { return { id: job.id, identity: job.identity, label: job.label, priority: job.priority, enqueuedAt: job.enqueuedAt, startedAt: job.startedAt || null }; }
