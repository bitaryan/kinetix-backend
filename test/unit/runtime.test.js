import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import request from 'supertest';

import { createApplication } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { startServer } from '../../src/runtime.js';

const config = () => loadConfig({ JWT_SECRET_KEY: 'runtime-test-secret-0123456789abcdef' });

test('readiness checks required infrastructure; liveness remains independent', async () => {
  let ready = true;
  let database = true;
  let shared = true;
  const prisma = { user: { async count() { if (!database) throw new Error('offline'); return 0; } } };
  const redis = { subscribe() {}, async check() { if (!shared) throw new Error('offline'); } };
  const api = request(createApplication({ config: config(), prisma, redis, isReady: () => ready }).app);
  await api.get('/readyz').expect(200);
  ready = false;
  await api.get('/readyz').expect(503);
  ready = true;
  shared = false;
  await api.get('/readyz').expect(503);
  await api.get('/health').expect(200);
  shared = true;
  database = false;
  const failed = await api.get('/readyz').expect(503);
  assert.deepEqual(failed.body.error, { code: 'SERVICE_UNAVAILABLE', message: 'Service is not ready' });
  await api.get('/livez').expect(200);
});

test('server verifies storage and dependencies, listens, then disconnects once on repeated stop', async (t) => {
  const uploadDir = await mkdtemp(path.join(os.tmpdir(), 'gpss-runtime-test-'));
  t.after(() => rm(uploadDir, { recursive: true, force: true }));
  const calls = [];
  const prisma = {
    async $connect() { calls.push('connect'); },
    async $disconnect() { calls.push('disconnect'); },
    user: { async count() { calls.push('query'); return 0; } },
    attendanceSession: { async findMany() { return []; } },
    geofenceState: { async count() { return 0; } },
  };
  const runtime = await startServer({ config: { ...config(), uploadDir }, prisma, port: 0, host: '127.0.0.1' });
  t.after(() => runtime.stop());
  assert.deepEqual(calls, ['connect', 'query']);
  await request(runtime.server).get('/readyz').expect(200);
  await Promise.all([runtime.stop(), runtime.stop()]);
  assert.equal(runtime.server.listening, false);
  assert.equal(calls.filter((call) => call === 'disconnect').length, 1);
});

test('startup failure releases database and Redis without opening an HTTP port', async (t) => {
  const uploadDir = await mkdtemp(path.join(os.tmpdir(), 'gpss-startup-test-'));
  t.after(() => rm(uploadDir, { recursive: true, force: true }));
  let disconnected = 0;
  let closed = 0;
  await assert.rejects(startServer({
    config: { ...config(), uploadDir },
    prisma: {
      async $connect() {},
      async $disconnect() { disconnected += 1; },
      user: { async count() { throw new Error('Missing tables'); } },
    },
    redis: { close() { closed += 1; } },
    port: 0,
  }), /Missing tables/);
  assert.equal(disconnected, 1);
  assert.equal(closed, 1);
});

test('shutdown drains an in-flight request before disconnecting persistence', async (t) => {
  const uploadDir = await mkdtemp(path.join(os.tmpdir(), 'gpss-drain-test-'));
  t.after(() => rm(uploadDir, { recursive: true, force: true }));
  let queryCount = 0;
  let finish;
  let began;
  let disconnected = false;
  const pendingQuery = new Promise((resolve) => { finish = resolve; });
  const queryStarted = new Promise((resolve) => { began = resolve; });
  const runtime = await startServer({
    config: { ...config(), uploadDir }, port: 0, host: '127.0.0.1',
    prisma: {
      async $connect() {},
      async $disconnect() { disconnected = true; },
      attendanceSession: { async findMany() { return []; } },
    geofenceState: { async count() { return 0; } },
      user: { async count() {
        if (++queryCount > 1) { began(); await pendingQuery; }
        return 0;
      } },
    },
  });
  t.after(() => runtime.stop());
  const response = request(runtime.server).get('/readyz').then((result) => result);
  await queryStarted;
  const stopping = runtime.stop();
  assert.equal(disconnected, false);
  finish();
  assert.equal((await response).status, 200);
  await stopping;
  assert.equal(disconnected, true);
});
