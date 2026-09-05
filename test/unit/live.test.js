import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import WebSocket from 'ws';

import { ApiError } from '../../src/common/api.js';
import { livePresence, toLiveLocationData } from '../../src/live/hub.js';
import { attachLiveWebSocket } from '../../src/live/websocket.js';

const config = { liveStaleAfterSeconds: 120, liveOfflineAfterSeconds: 900 };

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once('message', (message) => resolve(message.toString()));
    ws.once('error', reject);
  });
}

test('live presence and DTO use the V2 last-known columns', () => {
  const now = new Date('2026-08-25T10:15:00Z');
  assert.equal(livePresence(new Date('2026-08-25T10:13:00Z'), now, config), 'live');
  assert.equal(livePresence(new Date('2026-08-25T10:12:59Z'), now, config), 'stale');
  assert.equal(livePresence(new Date('2026-08-25T09:59:59Z'), now, config), 'offline');
  const data = toLiveLocationData({
    id: 'session',
    status: 'punched_in',
    lastKnownLatitude: 28.6,
    lastKnownLongitude: 77.2,
    lastKnownAccuracy: null,
    lastKnownCapturedAt: new Date('2026-08-25T10:14:00Z'),
  }, {
    id: 'user', employeeId: 'EMP1001', employeeName: 'Employee',
  }, config, now);
  assert.equal(data.sessionId, 'session');
  assert.equal(data.presence, 'live');
  assert.equal(data.capturedAt, '2026-08-25T10:14:00.000Z');
});

test('raw WebSocket endpoint accepts STOMP auth and publishes topic messages', async (t) => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const listeners = new Set();
  const liveHub = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const bridge = attachLiveWebSocket({
    server,
    liveHub,
    auth: {
      async authenticateToken(token) {
        assert.equal(token, 'valid-token');
        return { user: { role: 'MANAGER' }, sessionId: 'session' };
      },
    },
  });
  t.after(async () => {
    bridge.detach();
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send('CONNECT\naccept-version:1.2\nAuthorization:Bearer valid-token\n\n\0');
  assert.match(await nextMessage(ws), /^CONNECTED\n/);

  ws.send('SUBSCRIBE\nid:live-1\ndestination:/topic/live-locations\nreceipt:subscribed\n\n\0');
  assert.match(await nextMessage(ws), /^RECEIPT\nreceipt-id:subscribed/);
  const message = nextMessage(ws);
  for (const listener of listeners) listener({ sessionId: 'attendance', presence: 'live' });
  const frame = await message;
  assert.match(frame, /^MESSAGE\n/);
  assert.match(frame, /subscription:live-1/);
  assert.match(frame, /"sessionId":"attendance"/);
  ws.close();
});

async function socketFixture(t, { limits, authenticateToken, config: socketConfig, origin } = {}) {
  const server = http.createServer();
  const listeners = new Set();
  const bridge = attachLiveWebSocket({
    server,
    limits,
    config: socketConfig,
    liveHub: { subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
    auth: { authenticateToken: authenticateToken ?? (async () => ({ user: { role: 'MANAGER' } })) },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    bridge.detach();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const ws = new WebSocket(url, origin ? { origin } : undefined);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, bridge, listeners, url };
}

function nextClose(ws) {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

const CONNECT = 'CONNECT\naccept-version:1.2\nAuthorization:Bearer token\n\n\0';

test('invalid UTF-8 and oversized WebSocket messages close only their connection', async (t) => {
  for (const payload of [Buffer.from([0xff]), Buffer.alloc(129, 'a')]) {
    const { ws } = await socketFixture(t, { limits: { frameBytes: 128 } });
    const closed = nextClose(ws);
    ws.send(payload, { binary: false });
    await closed;
    assert.equal(ws.readyState, WebSocket.CLOSED);
  }
});

test('incomplete STOMP frames are bounded across WebSocket messages', async (t) => {
  const { ws } = await socketFixture(t, { limits: { frameBytes: 128 } });
  const closed = nextClose(ws);
  ws.send('a'.repeat(80));
  ws.send('b'.repeat(80));
  assert.equal(await closed, 1008);
});

test('unauthenticated WebSockets must finish CONNECT before the deadline', async (t) => {
  const { ws } = await socketFixture(t, { limits: { connectTimeoutMs: 50 } });
  assert.equal(await nextClose(ws), 1008);
});

test('STOMP queue and subscription counts have per-connection bounds', async (t) => {
  const pending = await socketFixture(t, { limits: { queuedFrames: 2 } });
  const closed = nextClose(pending.ws);
  pending.ws.send(`${CONNECT}\n\0\n\0`);
  assert.equal(await closed, 1008);

  const { ws } = await socketFixture(t, { limits: { subscriptions: 1 } });
  let message = nextMessage(ws);
  ws.send(CONNECT);
  assert.match(await message, /^CONNECTED/);
  message = nextMessage(ws);
  ws.send('SUBSCRIBE\nid:one\ndestination:/topic/live-locations\nreceipt:first\n\n\0');
  assert.match(await message, /^RECEIPT/);
  const limited = nextClose(ws);
  ws.send('SUBSCRIBE\nid:two\ndestination:/topic/live-locations\n\n\0');
  assert.equal(await limited, 1008);
});

test('slow live subscribers cannot accumulate unlimited outgoing messages', async (t) => {
  const { ws, bridge, listeners } = await socketFixture(t);
  let message = nextMessage(ws);
  ws.send(CONNECT);
  await message;
  message = nextMessage(ws);
  ws.send('SUBSCRIBE\nid:one\ndestination:/topic/live-locations\nreceipt:first\n\n\0');
  await message;
  const serverSocket = [...bridge.wss.clients][0];
  Object.defineProperty(serverSocket, 'bufferedAmount', { value: 1024 * 1024 });
  const closed = nextClose(ws);
  for (const listener of listeners) listener({ sessionId: 'attendance' });
  await closed;
  assert.equal(ws.readyState, WebSocket.CLOSED);
});

async function subscribe(ws) {
  let message = nextMessage(ws);
  ws.send(CONNECT);
  assert.match(await message, /^CONNECTED/);
  message = nextMessage(ws);
  ws.send('SUBSCRIBE\nid:live\ndestination:/topic/live-locations\nreceipt:ready\n\n\0');
  assert.match(await message, /^RECEIPT/);
}

for (const change of ['revoked', 'expired', 'role changed']) {
  test(`live broadcasts revalidate credentials when ${change}`, { timeout: 2000 }, async (t) => {
    let changed = false;
    const { ws, listeners } = await socketFixture(t, {
      async authenticateToken() {
        if (changed && change === 'role changed') return { user: { role: 'EMPLOYEE' } };
        if (changed) throw new ApiError(401, 'UNAUTHORIZED', change === 'expired'
          ? 'Invalid or expired access token' : 'Access session is no longer active');
        return { user: { role: 'MANAGER' } };
      },
    });
    await subscribe(ws);
    const frames = [];
    ws.on('message', (frame) => frames.push(frame.toString()));
    const closed = nextClose(ws);
    changed = true;
    for (const listener of listeners) listener({ sessionId: 'private-location' });
    assert.equal(await closed, 1008);
    assert.ok(frames.some((frame) => frame.startsWith('ERROR')));
    assert.ok(frames.every((frame) => !frame.includes('private-location')));
  });
}

test('idle dashboard sockets revalidate without a new location event', { timeout: 2000 }, async (t) => {
  let reads = 0;
  const { ws } = await socketFixture(t, {
    limits: { revalidateIntervalMs: 20 },
    async authenticateToken() {
      if (++reads > 1) throw new ApiError(401, 'UNAUTHORIZED', 'Access session is no longer active');
      return { user: { role: 'MANAGER' } };
    },
  });
  const closed = nextClose(ws);
  const message = nextMessage(ws);
  ws.send(CONNECT);
  assert.match(await message, /^CONNECTED/);
  assert.equal(await closed, 1008);
  assert.equal(reads, 2);
});

test('browser WebSocket upgrades use the configured exact origin allow-list', { timeout: 2000 }, async (t) => {
  const { ws, url } = await socketFixture(t, {
    config: { corsOrigins: ['https://dashboard.example.com'] }, origin: 'https://dashboard.example.com',
  });
  await subscribe(ws);
  const rejected = new WebSocket(url, { origin: 'https://untrusted.example.com' });
  rejected.on('error', () => {});
  const response = await new Promise((resolve) => rejected.once('unexpected-response', (_req, res) => resolve(res)));
  assert.equal(response.statusCode, 403);
  response.resume();
  rejected.terminate();
});

test('a stalled authorization has a deadline and bounded queued live updates', { timeout: 2000 }, async (t) => {
  let stalled = false;
  let release;
  let calls = 0;
  const { ws, listeners } = await socketFixture(t, {
    limits: { queuedFrames: 2, authTimeoutMs: 50 },
    async authenticateToken() {
      calls += 1;
      if (stalled) await new Promise((resolve) => { release = resolve; });
      return { user: { role: 'MANAGER' } };
    },
  });
  await subscribe(ws);
  stalled = true;
  const closed = nextClose(ws);
  for (const listener of listeners) listener({ sessionId: 'first' });
  await new Promise((resolve) => setImmediate(resolve));
  for (const listener of listeners) {
    listener({ sessionId: 'second' });
    listener({ sessionId: 'third' });
  }
  assert.equal(await closed, 1008);
  assert.equal(calls, 2);
  release();
});

test('authorization deadlines close sockets even without further input or events', { timeout: 2000 }, async (t) => {
  let stalled = false;
  let release;
  const { ws, listeners } = await socketFixture(t, {
    limits: { authTimeoutMs: 20 },
    async authenticateToken() {
      if (stalled) await new Promise((resolve) => { release = resolve; });
      return { user: { role: 'MANAGER' } };
    },
  });
  await subscribe(ws);
  stalled = true;
  const closed = nextClose(ws);
  for (const listener of listeners) listener({ sessionId: 'pending' });
  assert.equal(await closed, 1008);
  release();
});
