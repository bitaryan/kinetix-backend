import { randomUUID } from 'node:crypto';

import { createClient } from 'redis';

import { ApiError } from '../common/api.js';

function unavailable() {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'Shared infrastructure is unavailable');
}

export function createRedisInfrastructure(config) {
  const timeout = config.redisCommandTimeoutMs;
  const client = createClient({
    url: config.redisUrl,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 1024,
    socket: {
      connectTimeout: timeout,
      reconnectStrategy: (retries) => Math.min(100 * (2 ** Math.min(retries, 5)), 3000),
    },
  });
  const subscriber = client.duplicate();
  const channel = `${config.redisKeyPrefix}:live-locations`;
  const instanceId = randomUUID();
  const listeners = new Set();
  let closed = false;

  for (const connection of [client, subscriber]) {
    // Error messages may include connection credentials. Never print them.
    connection.on('error', () => {});
  }

  async function execute(operation) {
    if (closed || !client.isReady) throw unavailable();
    try {
      return await operation(client.withCommandOptions({ abortSignal: AbortSignal.timeout(timeout) }));
    } catch {
      throw unavailable();
    }
  }

  function receive(raw) {
    if (Buffer.byteLength(raw) > 64 * 1024) return;
    try {
      const event = JSON.parse(raw);
      if (event.source === instanceId || !event.data || typeof event.data !== 'object'
          || typeof event.data.userId !== 'string') return;
      const removal = event.data.status === 'tracking_disabled'
        && event.data.locationTrackingEnabled === false
        && event.data.latitude === null && event.data.longitude === null
        && event.data.accuracy === null && event.data.capturedAt === null;
      if (!removal && (event.data.status === 'tracking_disabled' || typeof event.data.sessionId !== 'string')) return;
      for (const listener of listeners) listener(event.data);
    } catch {
      console.warn('Ignored invalid shared live-location update');
    }
  }

  function close() {
    closed = true;
    listeners.clear();
    for (const connection of [client, subscriber]) {
      if (connection.isOpen) connection.destroy();
    }
  }

  async function connect() {
    let timer;
    try {
      await Promise.race([
        (async () => {
          await Promise.all([client.connect(), subscriber.connect()]);
          await subscriber.subscribe(channel, receive);
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(unavailable()), timeout); }),
      ]);
    } catch {
      close();
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    connect,
    close,
    execute,
    isReady: () => !closed && client.isReady && subscriber.isReady,
    async check() {
      if (closed || !subscriber.isReady) throw unavailable();
      await execute((connection) => connection.ping());
    },
    publish(data) {
      return execute((connection) => connection.publish(channel, JSON.stringify({ source: instanceId, data })));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
