import { createId } from '../../core/ids.js';
import { NumiOSError } from '../../core/errors.js';
import { EventHub } from '../../core/events.js';

export class IpcBus {
  constructor({ events = new EventHub(), maxMessageBytes = 1024 * 1024, maxQueuedMessages = 1000, logger = null } = {}) {
    this.events = events;
    this.maxMessageBytes = maxMessageBytes;
    this.maxQueuedMessages = maxQueuedMessages;
    this.logger = logger;
    this.channels = new Map();
  }

  create({ owner, name = 'channel', scope = 'process', readers = [], writers = [], capacity = 128 } = {}) {
    const ownerId = principalId(owner);
    if (!ownerId) throw new NumiOSError('UNAUTHORIZED_CALLER', 'IPC channel owner identity is required.');
    if (!['process', 'shared', 'system'].includes(scope)) throw new NumiOSError('INVALID_ARGUMENT', 'IPC scope must be process, shared, or system.');
    const id = createId('ipc');
    const channel = {
      id, name: String(name).slice(0, 128), owner: ownerId, scope,
      readers: new Set(readers.map(principalId)), writers: new Set(writers.map(principalId)),
      capacity: Math.max(1, Math.min(this.maxQueuedMessages, capacity)), queue: [], subscriptions: new Map(), createdAt: new Date().toISOString(), closed: false
    };
    this.channels.set(id, channel);
    this.events.emit('ipc.created', publicChannel(channel));
    return publicChannel(channel);
  }

  subscribe(channelId, { principal, signal } = {}) {
    const channel = this.#channel(channelId);
    const id = principalId(principal);
    this.#assertReadable(channel, id);
    const subscriptionId = createId('sub');
    const subscription = { id: subscriptionId, principal: id, queue: [], waiters: [], events: new EventHub(), closed: false };
    channel.subscriptions.set(subscriptionId, subscription);
    if (channel.queue.length) {
      subscription.queue.push(...channel.queue.splice(0));
    }
    if (signal) {
      if (signal.aborted) this.unsubscribe(channelId, subscriptionId, { principal: id });
      else signal.addEventListener('abort', () => this.unsubscribe(channelId, subscriptionId, { principal: id }), { once: true });
    }
    this.events.emit('ipc.subscribed', { channelId, subscriptionId, principal: id });
    return { channelId, subscriptionId };
  }

  async send(channelId, message, { sender } = {}) {
    const channel = this.#channel(channelId);
    const senderId = principalId(sender);
    this.#assertWritable(channel, senderId);
    const safeMessage = normalizeMessage(message, this.maxMessageBytes);
    const envelope = { id: createId('msg'), channelId, sender: senderId, sentAt: new Date().toISOString(), data: safeMessage };
    const subscriptions = [...channel.subscriptions.values()].filter(subscription => !subscription.closed && this.#canRead(channel, subscription.principal));
    if (subscriptions.length === 0) {
      if (channel.queue.length >= channel.capacity) throw new NumiOSError('IPC_QUEUE_FULL', 'IPC channel queue is full.', { channelId });
      channel.queue.push(envelope);
    } else {
      for (const subscription of subscriptions) {
        if (subscription.waiters.length) subscription.waiters.shift().resolve(envelope);
        else {
          if (subscription.queue.length >= channel.capacity) throw new NumiOSError('IPC_QUEUE_FULL', 'IPC subscriber queue is full.', { channelId, subscriptionId: subscription.id });
          subscription.queue.push(envelope);
        }
      }
    }
    this.events.emit('ipc.message', envelope);
    return { messageId: envelope.id, deliveredTo: subscriptions.length };
  }

  async receive(channelId, { subscriptionId = null, principal, timeoutMs = 30000, signal } = {}) {
    const channel = this.#channel(channelId);
    const id = principalId(principal);
    this.#assertReadable(channel, id);
    let subscription;
    let temporary = false;
    if (subscriptionId) subscription = this.#subscription(channel, subscriptionId, id);
    else {
      const created = this.subscribe(channelId, { principal });
      subscription = this.#subscription(channel, created.subscriptionId, id);
      temporary = true;
    }
    try {
      if (subscription.queue.length) return subscription.queue.shift();
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
      return await new Promise((resolve, reject) => {
        let timer;
        const waiter = { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } };
        const onAbort = () => waiter.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
        const cleanup = () => {
          const index = subscription.waiters.indexOf(waiter);
          if (index >= 0) subscription.waiters.splice(index, 1);
          signal?.removeEventListener('abort', onAbort);
          clearTimeout(timer);
        };
        subscription.waiters.push(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (Number.isFinite(timeoutMs)) timer = setTimeout(() => waiter.reject(new NumiOSError('TIMEOUT', 'Timed out waiting for an IPC message.', { channelId })), timeoutMs);
      });
    } finally {
      if (temporary && channel.subscriptions.has(subscription.id)) {
        if (subscription.queue.length) channel.queue.unshift(...subscription.queue);
        this.unsubscribe(channelId, subscription.id, { principal: id });
      }
    }
  }

  unsubscribe(channelId, subscriptionId, { principal } = {}) {
    const channel = this.#channel(channelId);
    const subscription = this.#subscription(channel, subscriptionId, principalId(principal));
    subscription.closed = true;
    for (const waiter of subscription.waiters.splice(0)) waiter.reject(new NumiOSError('IPC_SUBSCRIPTION_CLOSED', 'IPC subscription closed while waiting.'));
    subscription.events.clear();
    channel.subscriptions.delete(subscriptionId);
    this.events.emit('ipc.unsubscribed', { channelId, subscriptionId, principal: subscription.principal });
    return { unsubscribed: true, subscriptionId };
  }

  close(channelId, { principal, force = false } = {}) {
    const channel = this.#channel(channelId);
    const id = principalId(principal);
    if (!force && id !== channel.owner) throw new NumiOSError('IPC_ACCESS_DENIED', 'Only the channel owner may close it.');
    channel.closed = true;
    for (const subscription of channel.subscriptions.values()) {
      subscription.closed = true;
      for (const waiter of subscription.waiters.splice(0)) waiter.reject(new NumiOSError('IPC_CHANNEL_CLOSED', 'IPC channel closed while waiting.'));
      subscription.events.clear();
    }
    channel.subscriptions.clear();
    this.channels.delete(channelId);
    this.events.emit('ipc.closed', { channelId, owner: channel.owner });
    return { closed: true, channelId };
  }

  closeProcess(pid) {
    const id = `pid:${pid}`;
    let closedChannels = 0;
    let closedSubscriptions = 0;
    for (const channel of [...this.channels.values()]) {
      if (channel.owner === id) { this.close(channel.id, { principal: id, force: true }); closedChannels += 1; continue; }
      for (const [subscriptionId, subscription] of channel.subscriptions) if (subscription.principal === id) {
        this.unsubscribe(channel.id, subscriptionId, { principal: id });
        closedSubscriptions += 1;
      }
    }
    return { closedChannels, closedSubscriptions };
  }

  list({ principal = null, includeShared = false } = {}) {
    const id = principalId(principal);
    return [...this.channels.values()].filter(channel => includeShared || channel.owner === id || channel.scope === 'shared' || channel.scope === 'system').map(publicChannel);
  }

  status() { return { channelCount: this.channels.size, subscriptionCount: [...this.channels.values()].reduce((sum, channel) => sum + channel.subscriptions.size, 0) }; }

  #channel(id) {
    const channel = this.channels.get(id);
    if (!channel || channel.closed) throw new NumiOSError('IPC_CHANNEL_NOT_FOUND', 'IPC channel does not exist.', { channelId: id });
    return channel;
  }
  #subscription(channel, id, principal) {
    const subscription = channel.subscriptions.get(id);
    if (!subscription || subscription.closed || subscription.principal !== principal) throw new NumiOSError('IPC_SUBSCRIPTION_NOT_FOUND', 'IPC subscription does not exist for this caller.');
    return subscription;
  }
  #canRead(channel, id) { return channel.owner === id || channel.readers.has(id) || (channel.scope === 'shared' && Boolean(id)) || channel.scope === 'system'; }
  #assertReadable(channel, id) { if (!this.#canRead(channel, id)) throw new NumiOSError('IPC_ACCESS_DENIED', 'Caller is not permitted to receive from this IPC channel.'); }
  #assertWritable(channel, id) { if (!(channel.owner === id || channel.writers.has(id) || (channel.scope === 'shared' && Boolean(id)) || channel.scope === 'system')) throw new NumiOSError('IPC_ACCESS_DENIED', 'Caller is not permitted to send to this IPC channel.'); }
}

function principalId(principal) {
  if (typeof principal === 'string') return principal.startsWith('pid:') || principal === 'system' ? principal : `pid:${principal}`;
  if (principal?.principalId) return principal.principalId;
  if (principal?.processId !== null && principal?.processId !== undefined) return `pid:${principal.processId}`;
  if (principal?.id === 'system') return 'system';
  return principal?.id || null;
}
function normalizeMessage(message, maxBytes) {
  let text;
  try { text = JSON.stringify(message); } catch { throw new NumiOSError('IPC_MESSAGE_INVALID', 'IPC message must be JSON-serializable.'); }
  if (text === undefined || new TextEncoder().encode(text).byteLength > maxBytes) throw new NumiOSError('IPC_MESSAGE_TOO_LARGE', 'IPC message exceeds the configured limit.', { maxBytes });
  try { return JSON.parse(text); } catch { throw new NumiOSError('IPC_MESSAGE_INVALID', 'IPC message is not valid JSON.'); }
}
function publicChannel(channel) { return { id: channel.id, name: channel.name, owner: channel.owner, scope: channel.scope, readers: [...channel.readers], writers: [...channel.writers], capacity: channel.capacity, queued: channel.queue.length, subscriptions: channel.subscriptions.size, createdAt: channel.createdAt }; }
