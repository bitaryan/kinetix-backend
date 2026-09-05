import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';
import request from 'supertest';

import { createAttendanceRouter } from '../../src/attendance/router.js';
import { ApiError, errorHandler } from '../../src/common/api.js';
import { loadConfig } from '../../src/config/env.js';

function fixture() {
  const app = express();
  const config = loadConfig({ JWT_SECRET_KEY: 'attendance-http-test-secret-0123456789' });
  app.use(express.json());
  app.use(createAttendanceRouter({
    config,
    service: {
      async punchIn() { assert.fail('Invalid multipart must not reach the service'); },
      async locationPing() { assert.fail('Rate-limited GPS must not reach the service'); },
      async locationPingBatch() { assert.fail('Rate-limited GPS must not reach the service'); },
    },
    auth: {
      authenticate(req, _res, next) { req.principal = { user: { id: 'employee', role: 'EMPLOYEE' } }; next(); },
      requireRoles() { return (_req, _res, next) => next(); },
    },
    rateLimiter: {
      async enforceLocationPing() {
        await new Promise((resolve) => setImmediate(resolve));
        throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Please try again later');
      },
    },
  }));
  app.use(errorHandler);
  return request(app);
}

test('attendance multipart errors and excessive text fields keep validation envelopes', async () => {
  const api = fixture();
  for (const [type, body] of [
    ['multipart/form-data', 'no-boundary'],
    ['multipart/form-data; boundary=broken', '--broken\r\nContent-Disposition: form-data; name="accuracy"\r\n\r\n10'],
  ]) {
    const result = await api.post('/api/v1/attendance/punch-in').set('Content-Type', type).send(body).expect(422);
    assert.equal(result.body.error.code, 'VALIDATION_ERROR');
  }
  await api.post('/api/v1/attendance/punch-in').field('extra', 'x'.repeat(16 * 1024 + 1)).expect(422);
});

test('single and batch GPS wait for distributed rate-limit decisions', async () => {
  const api = fixture();
  const point = { latitude: 28, longitude: 77, capturedAt: new Date().toISOString() };
  const sessionId = '12345678-1234-1234-1234-123456789012';
  await api.post('/api/v1/attendance/location-ping').send({ sessionId, ...point }).expect(429);
  await api.post('/api/v1/attendance/location-pings').send({ sessionId, pings: Array.from({ length: 120 }, () => point) }).expect(429);
});
