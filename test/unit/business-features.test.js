import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Prisma } from '@prisma/client';
import express from 'express';
import request from 'supertest';

import { createClientLogRouter } from '../../src/clientlog/index.js';
import { ApiError, errorHandler } from '../../src/common/api.js';
import { createHealthRouter } from '../../src/health/index.js';
import { createLeaveRouter } from '../../src/leave/index.js';
import { createUploadRouter } from '../../src/upload/index.js';

const EMPLOYEE_ID = '11111111-1111-4111-8111-111111111111';
const MANAGER_ID = '22222222-2222-4222-8222-222222222222';
const LEAVE_ID = '33333333-3333-4333-8333-333333333333';

function fakeAuth(user) {
  return {
    authenticate(req, _res, next) {
      req.principal = { user, sessionId: '44444444-4444-4444-8444-444444444444' };
      next();
    },
    requireRoles(...roles) {
      return (req, _res, next) => {
        if (!roles.includes(req.principal.user.role)) {
          next(new ApiError(403, 'FORBIDDEN', 'You do not have permission for this action'));
          return;
        }
        next();
      };
    },
  };
}

function appAt(mount, router, { json = true } = {}) {
  const app = express();
  if (json) app.use(express.json());
  app.use(mount, router);
  app.use(errorHandler);
  return app;
}

test('leave apply retries serializable conflicts and preserves the frozen response', async () => {
  const createdAt = new Date('2026-08-25T10:00:00.000Z');
  const tx = {
    user: { findUnique: async () => ({ id: EMPLOYEE_ID, isActive: true }) },
    leave: {
      findFirst: async () => null,
      create: async ({ data }) => ({ id: LEAVE_ID, ...data, createdAt }),
    },
  };
  let attempts = 0;
  const prisma = {
    async $transaction(operation, options) {
      assert.equal(options.isolationLevel, 'Serializable');
      attempts += 1;
      if (attempts < 3) {
        const conflict = new Error('serialization conflict');
        conflict.code = 'P2034';
        throw conflict;
      }
      return operation(tx);
    },
    leave: {},
  };
  const auth = fakeAuth({ id: EMPLOYEE_ID, role: 'EMPLOYEE' });
  const app = appAt('/api/v1/leaves', createLeaveRouter({ prisma, auth }));

  const response = await request(app)
    .post('/api/v1/leaves')
    .send({ start_date: '25/08/26', end_date: '26/08/2026', reason: '  Sick leave  ' })
    .expect(201);

  assert.equal(attempts, 3);
  assert.deepEqual(response.body, {
    success: true,
    data: {
      id: LEAVE_ID,
      user_id: EMPLOYEE_ID,
      start_date: '25/08/26',
      end_date: '26/08/26',
      reason: 'Sick leave',
      status: 'Pending',
      created_at: createdAt.toISOString(),
      message: 'Leave application submitted successfully',
    },
    error: null,
  });
});

test('client-log list escapes wildcards, scopes the user, and emits numeric decimals', async () => {
  const createdAt = new Date('2026-08-25T11:00:00.000Z');
  let findArguments;
  const prisma = {
    clientLog: {
      count: async () => 1,
      findMany: async (args) => {
        findArguments = args;
        return [{
          id: LEAVE_ID,
          userId: EMPLOYEE_ID,
          clientName: 'Solar%Co',
          companyName: 'Literal Percent',
          mobileNumber: '9876543210',
          mailId: 'percent@example.com',
          logDate: new Date('2026-08-25T00:00:00.000Z'),
          selfiePath: null,
          latitude: new Prisma.Decimal('26.91240000'),
          longitude: new Prisma.Decimal('75.78730000'),
          locationAccuracy: null,
          createdAt,
        }];
      },
    },
  };
  const config = { uploadDir: '/unused', maxUploadBytes: 5_242_880, publicBaseUrl: '' };
  const auth = fakeAuth({ id: EMPLOYEE_ID, role: 'EMPLOYEE' });
  const app = appAt('/api/v1/client-logs', createClientLogRouter({ prisma, config, auth }));

  const response = await request(app)
    .get('/api/v1/client-logs')
    .query({ search: 'Solar%' })
    .expect(200);

  assert.equal(findArguments.where.userId, EMPLOYEE_ID);
  assert.equal(findArguments.where.OR[0].clientName.contains, 'Solar\\%');
  assert.equal(response.body.data[0].latitude, 26.9124);
  assert.equal(response.body.data[0].longitude, 75.7873);
  assert.equal(response.body.data[0].locationAccuracy, null);
  assert.deepEqual(response.body.meta, { page: 1, limit: 20, totalCount: 1, totalPages: 1 });
});

test('client-log multipart create validates and serializes its intentionally smaller shape', async () => {
  let stored;
  let createData;
  const createdAt = new Date('2026-08-25T12:00:00.000Z');
  const images = {
    async saveClientLogSelfie(file, userId, id) {
      stored = { file, userId, id };
      return `client_logs/2026/08/${userId}/${id}.jpg`;
    },
    async deleteStoredFiles() {},
    selfieUrl(relative) {
      return relative ? `/uploads/${relative}` : null;
    },
  };
  const prisma = {
    clientLog: {
      async create({ data }) {
        createData = data;
        return { ...data, createdAt };
      },
    },
  };
  const config = { uploadDir: '/unused', maxUploadBytes: 5_242_880, publicBaseUrl: '' };
  const auth = fakeAuth({ id: EMPLOYEE_ID, role: 'EMPLOYEE' });
  const app = appAt(
    '/api/v1/client-logs',
    createClientLogRouter({ prisma, config, auth, imageStorage: images }),
  );

  const response = await request(app)
    .post('/api/v1/client-logs')
    .field('client_name', 'Aryan Jain')
    .field('company_name', 'Arihant Power')
    .field('mobile_number', '7727868603')
    .field('mail_id', 'ARYAN@EXAMPLE.COM')
    .field('date', '25/08/2026')
    .field('latitude', '26.912400005')
    .field('longitude', '75.7873')
    .field('accuracy', '12.5')
    .attach('selfie', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
      filename: 'selfie.jpg',
      contentType: 'image/jpeg',
    })
    .expect(201);

  assert.equal(stored.userId, EMPLOYEE_ID);
  assert.equal(createData.mailId, 'aryan@example.com');
  assert.equal(createData.latitude.toString(), '26.91240001');
  assert.equal(response.body.data.mailId, 'aryan@example.com');
  assert.equal(response.body.data.latitude, 26.91240001);
  assert.equal(response.body.data.locationAccuracy, undefined);
  assert.equal(response.body.data.userId, undefined);
});

test('upload serving authorizes layout ownership and blocks a symlink escape', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'gpss-upload-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'uploads');
  const sessionId = '55555555-5555-4555-8555-555555555555';
  const directory = path.join(root, 'attendance', EMPLOYEE_ID, sessionId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'selfie.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
  const outside = path.join(temporary, 'outside.jpg');
  await writeFile(outside, Buffer.from([0xff, 0xd8, 0xff]));
  await symlink(outside, path.join(directory, 'escape.jpg'));

  const auth = fakeAuth({ id: EMPLOYEE_ID, role: 'EMPLOYEE' });
  const app = appAt('/uploads', createUploadRouter({ config: { uploadDir: root }, auth }), { json: false });

  await request(app)
    .get(`/uploads/attendance/${EMPLOYEE_ID}/${sessionId}/selfie.jpg`)
    .expect('Content-Type', /image\/jpeg/)
    .expect('Cache-Control', 'private, no-store')
    .expect(200);
  await request(app)
    .get(`/uploads/attendance/${EMPLOYEE_ID}/${sessionId}/escape.jpg`)
    .expect(404);
});

test('client-log multipart rejects database length overflow and excessive text parts', async () => {
  const prisma = { clientLog: { create: async () => assert.fail('Invalid input must not reach persistence') } };
  const config = { uploadDir: '/unused', maxUploadBytes: 5_242_880, publicBaseUrl: '' };
  const auth = fakeAuth({ id: EMPLOYEE_ID, role: 'EMPLOYEE' });
  const app = appAt('/api/v1/client-logs', createClientLogRouter({ prisma, config, auth }));
  const valid = {
    client_name: 'Client', company_name: 'Company', mobile_number: '9876543210',
    mail_id: 'client@example.com', date: '05/09/2026',
  };
  for (const change of [
    { client_name: 'a'.repeat(151) },
    { company_name: 'a'.repeat(201) },
    { mail_id: `${'a'.repeat(244)}@example.com` },
    { latitude: '91', longitude: '0' },
    { latitude: '0', longitude: '-181' },
    { accuracy: '-1' },
    { extra: 'a'.repeat(16 * 1024 + 1) },
    Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`extra${index}`, 'value'])),
  ]) {
    const response = await request(app).post('/api/v1/client-logs').field({ ...valid, ...change });
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  }
});

test('client-log malformed multipart bodies keep the validation response', async () => {
  const config = { uploadDir: '/unused', maxUploadBytes: 5_242_880, publicBaseUrl: '' };
  const auth = fakeAuth({ id: EMPLOYEE_ID, role: 'EMPLOYEE' });
  const prisma = { clientLog: { create: async () => assert.fail('Malformed bodies must not create logs') } };
  const app = appAt('/api/v1/client-logs', createClientLogRouter({ prisma, config, auth }));
  for (const [contentType, body] of [
    ['multipart/form-data', 'missing-boundary'],
    ['multipart/form-data; boundary=broken', '--broken\r\nContent-Disposition: form-data; name="date"\r\n\r\n05/09/2026'],
  ]) {
    const response = await request(app).post('/api/v1/client-logs')
      .set('Content-Type', contentType).send(body);
    assert.equal(response.status, 422);
    assert.deepEqual(response.body, {
      success: false, data: null,
      error: { code: 'VALIDATION_ERROR', message: 'Request data is invalid' },
    });
  }
});

test('health emits exact healthy and unavailable envelopes', async () => {
  const healthy = appAt('/health', createHealthRouter({
    prisma: { user: { count: async () => 3 } },
  }));
  await request(healthy)
    .get('/health')
    .expect(200, { success: true, data: { status: 'ok' }, error: null });

  const originalError = console.error;
  console.error = () => {};
  try {
    const unhealthy = appAt('/health', createHealthRouter({
      prisma: { user: { count: async () => { throw new Error('database unavailable'); } } },
    }));
    await request(unhealthy)
      .get('/health')
      .expect(503, {
        success: false,
        data: null,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Database is unavailable' },
      });
  } finally {
    console.error = originalError;
  }
});
