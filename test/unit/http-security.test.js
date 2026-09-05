import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp, createApplication } from '../../src/app.js';
import { errorHandler } from '../../src/common/api.js';
import { loadConfig } from '../../src/config/env.js';

const config = loadConfig({
  JWT_SECRET_KEY: 'http-security-test-secret-0123456789abcdef',
  DATABASE_URL: 'postgresql://dummy:dummy@127.0.0.1:1/gpss_security_test',
});
const prisma = {
  async $transaction(operation) {
    return operation({ user: { findUnique: async () => null } });
  },
};

test('authentication precedes JSON parsing on protected and unknown paths', async () => {
  const app = createApp({ config, prisma });
  for (const pathname of ['/api/v1/leaves', '/api/v1/auth/users', '/unknown']) {
    const response = await request(app).post(pathname)
      .set('Content-Type', 'application/json').send('{');
    assert.equal(response.status, 401);
    assert.deepEqual(response.body.error, {
      code: 'UNAUTHORIZED', message: 'A bearer access token is required',
    });
  }
  const expired = await request(app).post('/api/v1/leaves')
    .set('Content-Type', 'application/json').set('Authorization', 'Bearer invalid').send('{');
  assert.equal(expired.status, 401);
  assert.equal(expired.body.error.message, 'Invalid or expired access token');
  const oversized = await request(app).post('/api/v1/leaves').send({ value: 'a'.repeat(110_000) });
  assert.equal(oversized.status, 401);
});

test('public auth endpoints still parse JSON without a bearer token', async () => {
  const app = createApp({ config, prisma });
  const login = await request(app).post('/api/v1/auth/login').send({
    userId: 'EMP0001', password: 'Valid-password-123', role: 'EMPLOYEE',
  });
  assert.equal(login.status, 401);
  assert.equal(login.body.error.code, 'INVALID_CREDENTIALS');
  const malformed = await request(app).post('/api/v1/auth/login')
    .set('Content-Type', 'application/json').send('{');
  assert.equal(malformed.status, 422);
  const refresh = await request(app).post('/api/v1/auth/refresh').send({});
  assert.equal(refresh.status, 401);
  assert.equal(refresh.body.error.code, 'INVALID_REFRESH_TOKEN');
});

test('body-parser client errors retain the validation envelope without logging bodies', async () => {
  const app = createApp({ config, prisma });
  const responses = [
    await request(app).post('/api/v1/auth/login').send({ password: 'a'.repeat(110_000) }),
    await request(app).post('/api/v1/auth/login')
      .set('Content-Type', 'application/json; charset=iso-8859-1').send('{}'),
    await request(app).post('/api/v1/auth/login')
      .set('Content-Type', 'application/json').set('Content-Encoding', 'unsupported').send('{}'),
    await request(app).post('/api/v1/auth/login')
      .set('Content-Type', 'application/json').set('Content-Encoding', 'gzip').send('not gzip'),
  ];
  for (const response of responses) {
    assert.equal(response.status, 422);
    assert.deepEqual(response.body, {
      success: false, data: null,
      error: { code: 'VALIDATION_ERROR', message: 'Request data is invalid' },
    });
  }
});

test('protected feature JSON reloads the session and user once per request', async () => {
  const userId = '12345678-1234-1234-1234-123456789012';
  const sessionId = '12345678-1234-1234-1234-123456789013';
  let sessionReads = 0;
  let userReads = 0;
  const application = createApplication({
    config,
    prisma: {
      activeSession: { async findUnique() {
        sessionReads += 1;
        return { id: sessionId, userId, isRevoked: false, expiresAt: new Date(Date.now() + 60_000) };
      } },
      user: { async findUnique() {
        userReads += 1;
        return { id: userId, role: 'EMPLOYEE', isActive: true };
      } },
    },
  });
  const token = application.auth.jwtService.createAccessToken(userId, sessionId, 'EMPLOYEE');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await request(application.app).post('/api/v1/attendance/location-ping')
      .set('Authorization', `Bearer ${token}`).send({});
    assert.equal(response.status, 422);
    assert.equal(sessionReads, attempt + 1);
    assert.equal(userReads, attempt + 1);
  }
});

test('unknown error logs contain only allow-listed names and Prisma codes', (t) => {
  const logger = t.mock.method(console, 'error', () => {});
  const sensitive = 'sensitive-password-and-token-hash';
  const error = Object.assign(new Error(sensitive), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2000',
    body: sensitive,
    meta: { passwordHash: sensitive, refreshTokenHash: sensitive },
  });
  const res = { status(value) { assert.equal(value, 500); return this; }, json(value) {
    assert.equal(value.error.code, 'INTERNAL_ERROR'); return this;
  } };
  errorHandler(error, {}, res, () => assert.fail('Unexpected next call'));
  errorHandler({ name: sensitive, code: sensitive, message: sensitive }, {}, res, () => {});
  assert.deepEqual(logger.mock.calls[0].arguments, [
    'Unhandled application error', { name: 'PrismaClientKnownRequestError', code: 'P2000' },
  ]);
  assert.deepEqual(logger.mock.calls[1].arguments, [
    'Unhandled application error', { name: 'Error' },
  ]);
  assert.equal(JSON.stringify(logger.mock.calls).includes(sensitive), false);
});
