import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import request from 'supertest';

import { createApplication } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { createPrisma } from '../../src/db/prisma.js';
import { requireTestDatabaseUrl } from './database.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TINY_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
  0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0xff, 0xd9,
]);
const SECRET = 'integration-test-secret-0123456789abcdef0123456789abcdef';

function bearer(response) {
  return `Bearer ${response.body.data.accessToken}`;
}

function refreshCookie(response) {
  return response.headers['set-cookie']?.find((value) => value.startsWith('refresh_token='));
}

if (!TEST_DATABASE_URL) {
  test('API integration flow requires TEST_DATABASE_URL', { skip: true }, () => {});
} else {
  requireTestDatabaseUrl(TEST_DATABASE_URL);

  test('complete authenticated API flow preserves the deployed contract', async (t) => {
    const uploadDir = mkdtempSync(path.join(os.tmpdir(), 'gpss-node-integration-'));
    const config = loadConfig({
      APP_ENV: 'test',
      JWT_SECRET_KEY: SECRET,
      JWT_ALGORITHM: 'HS256',
      DATABASE_URL: TEST_DATABASE_URL,
      COOKIE_SECURE: 'false',
      COOKIE_SAMESITE: 'strict',
      BACKEND_CORS_ORIGINS: 'http://localhost:3000',
      LOGIN_RATE_LIMIT_PER_MINUTE: '1000',
      REFRESH_RATE_LIMIT_PER_MINUTE: '1000',
      LOCATION_PING_RATE_LIMIT_PER_MINUTE: '1000',
      LOCATION_PING_MIN_INTERVAL_SECONDS: '5',
      LOCATION_PING_MAX_PER_SESSION: '6000',
      LOCATION_PING_BATCH_MAX: '120',
      LOCATION_PING_MAX_ACCURACY_METERS: '100',
      UPLOAD_DIR: uploadDir,
      MAX_UPLOAD_BYTES: String(5 * 1024 * 1024),
    });
    const prisma = createPrisma(config);
    const application = createApplication({ config, prisma });
    const api = request(application.app);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const adminEmployeeId = `ADM${suffix}`.toUpperCase();
    const employeeEmployeeId = `EMP${suffix}`.toUpperCase();
    const managerEmployeeId = `MGR${suffix}`.toUpperCase();
    const previousSettings = await prisma.locationSettings.findUnique({
      where: { singletonKey: 'default' },
    });

    t.after(async () => {
      try {
        // Cascades remove only this run's fixture rows, never other test data.
        await prisma.user.deleteMany({
          where: { employeeId: { in: [adminEmployeeId, employeeEmployeeId, managerEmployeeId] } },
        });
        if (previousSettings) {
          await prisma.locationSettings.update({
            where: { singletonKey: 'default' },
            data: { locationMode: previousSettings.locationMode },
          });
        } else {
          await prisma.locationSettings.deleteMany({ where: { singletonKey: 'default' } });
        }
      } finally {
        await prisma.$disconnect();
        await rm(uploadDir, { recursive: true, force: true });
      }
    });
    await prisma.locationSettings.upsert({
      where: { singletonKey: 'default' },
      update: { locationMode: 'continuous' },
      create: { singletonKey: 'default', locationMode: 'continuous' },
    });

    assert.equal((await api.get('/health')).status, 200);

    const admin = await application.auth.service.createUser({
      userId: adminEmployeeId,
      employeeName: 'Admin User',
      email: `admin-${suffix}@example.com`,
      password: 'Admin-secure-pass-12',
      role: 'ADMIN',
    }, { allowAdminRole: true });
    const employee = await application.auth.service.createUser({
      userId: employeeEmployeeId,
      employeeName: 'Employee User',
      email: `employee-${suffix}@example.com`,
      password: 'Employee-pass-12',
      role: 'EMPLOYEE',
    });
    await application.auth.service.createUser({
      userId: managerEmployeeId,
      employeeName: 'Manager User',
      email: `manager-${suffix}@example.com`,
      password: 'Manager-pass-12',
      role: 'MANAGER',
    });
    assert.equal(admin.role, 'ADMIN');

    const employeeLogin = await api.post('/api/v1/auth/login').send({
      userId: employeeEmployeeId.toLowerCase(),
      password: 'Employee-pass-12',
      role: 'EMPLOYEE',
    });
    assert.equal(employeeLogin.status, 200);
    assert.equal(employeeLogin.body.data.user.userId, employeeEmployeeId);
    assert.match(refreshCookie(employeeLogin), /Path=\/api\/v1\/auth/);
    const employeeAuth = bearer(employeeLogin);

    const managerLogin = await api.post('/api/v1/auth/login').send({
      userId: managerEmployeeId,
      password: 'Manager-pass-12',
      role: 'MANAGER',
    });
    const managerAuth = bearer(managerLogin);
    const adminLogin = await api.post('/api/v1/auth/login').send({
      userId: adminEmployeeId,
      password: 'Admin-secure-pass-12',
      role: 'ADMIN',
    });
    const adminAuth = bearer(adminLogin);

    const me = await api.get('/api/v1/auth/me').set('Authorization', employeeAuth);
    assert.equal(me.status, 200);
    assert.equal(me.body.data.id, employee.id);
    assert.equal(me.body.data.passwordHash, undefined);

    const leave = await api
      .post('/api/v1/leaves')
      .set('Authorization', employeeAuth)
      .send({ start_date: '25/07/26', end_date: '25/07/26', reason: 'Sick Leave' });
    assert.equal(leave.status, 201);
    assert.equal(leave.body.data.status, 'Pending');
    const leaveList = await api.get('/api/v1/leaves').set('Authorization', employeeAuth);
    assert.deepEqual(leaveList.body.meta, { total: 1, page: 1, limit: 20 });
    const approved = await api
      .patch(`/api/v1/leaves/${leave.body.data.id}/status`)
      .set('Authorization', managerAuth)
      .send({ status: 'APPROVED', rejection_reason: null });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.data.status, 'Approved');
    const overlappingLeave = await api
      .post('/api/v1/leaves')
      .set('Authorization', employeeAuth)
      .send({ start_date: '25/07/26', end_date: '26/07/26', reason: 'Sick Leave' });
    assert.equal(overlappingLeave.status, 409);

    const concurrentLeaves = await Promise.all([0, 1].map(() => api
      .post('/api/v1/leaves')
      .set('Authorization', employeeAuth)
      .send({ start_date: '25/08/26', end_date: '26/08/26', reason: 'Concurrent application' })));
    assert.deepEqual(concurrentLeaves.map((response) => response.status).sort(), [201, 409]);
    assert.equal(concurrentLeaves.find((response) => response.status === 409).body.error.code, 'LEAVE_OVERLAP');
    const pendingLeave = concurrentLeaves.find((response) => response.status === 201).body.data;
    const decisions = await Promise.all(['APPROVED', 'REJECTED'].map((status) => api
      .patch(`/api/v1/leaves/${pendingLeave.id}/status`)
      .set('Authorization', managerAuth)
      .send({ status, rejection_reason: status === 'REJECTED' ? 'Concurrent decision' : null })));
    assert.deepEqual(decisions.map((response) => response.status).sort(), [200, 409]);
    assert.equal(decisions.find((response) => response.status === 409).body.error.code, 'INVALID_LEAVE_STATE');

    const clientLog = await api
      .post('/api/v1/client-logs')
      .set('Authorization', employeeAuth)
      .field('client_name', 'Aryan Jain')
      .field('company_name', 'Arihant Power Solutions')
      .field('mobile_number', '7727868603')
      .field('mail_id', 'ARYAN@example.com')
      .field('date', '25/07/2026')
      .field('latitude', '26.9124')
      .field('longitude', '75.7873')
      .field('accuracy', '12.5')
      .attach('selfie', TINY_JPEG, { filename: 'selfie.jpg', contentType: 'image/jpeg' });
    assert.equal(clientLog.status, 201);
    assert.equal(clientLog.body.data.mailId, 'aryan@example.com');
    assert.equal(clientLog.body.data.userId, undefined);
    const listedLogs = await api
      .get('/api/v1/client-logs?search=Aryan')
      .set('Authorization', employeeAuth);
    assert.equal(listedLogs.body.meta.totalCount, 1);
    assert.equal(listedLogs.body.data[0].userId, employee.id);

    await api
      .post('/api/v1/client-logs')
      .set('Authorization', employeeAuth)
      .field('client_name', 'Solar Co')
      .field('company_name', 'Plain Name')
      .field('mobile_number', '9876543210')
      .field('mail_id', 'plain@example.com')
      .field('date', '25/07/2026')
      .expect(201);
    await api
      .post('/api/v1/client-logs')
      .set('Authorization', employeeAuth)
      .field('client_name', 'Solar%Co')
      .field('company_name', 'Literal Percent')
      .field('mobile_number', '9123456780')
      .field('mail_id', 'percent@example.com')
      .field('date', '25/07/2026')
      .expect(201);
    const literalSearch = await api
      .get('/api/v1/client-logs?search=Solar%25')
      .set('Authorization', employeeAuth);
    assert.equal(literalSearch.body.meta.totalCount, 1);
    assert.equal(literalSearch.body.data[0].clientName, 'Solar%Co');

    const storedSelfie = await api
      .get(listedLogs.body.data[0].selfieUrl)
      .set('Authorization', employeeAuth);
    assert.equal(storedSelfie.status, 200);
    assert.equal(storedSelfie.headers['content-type'], 'image/jpeg');

    const shiftStartedAt = new Date(Date.now() - 60_000);
    const punchIns = await Promise.all([0, 1].map(() => api
      .post('/api/v1/attendance/punch-in')
      .set('Authorization', employeeAuth)
      .field('openingOdoKm', '1234.50')
      .field('latitude', '28.6139')
      .field('longitude', '77.2090')
      .field('accuracy', '12.5')
      .field('capturedAt', shiftStartedAt.toISOString())
      .attach('selfie', TINY_JPEG, { filename: 'selfie.jpg', contentType: 'image/jpeg' })
      .attach('openingOdoImage', TINY_JPEG, { filename: 'odo.jpg', contentType: 'image/jpeg' })));
    assert.deepEqual(punchIns.map((response) => response.status).sort(), [201, 409]);
    assert.equal(punchIns.find((response) => response.status === 409).body.error.code, 'ALREADY_PUNCHED_IN');
    const punchIn = punchIns.find((response) => response.status === 201);
    assert.equal(punchIn.status, 201);
    assert.equal(punchIn.body.data.openingOdoKm, '1234.50');
    const attendanceSessionId = punchIn.body.data.sessionId;
    // Shift boundaries use server punch times, not the submitted GPS timestamp.
    // Move only this fixture's start backward to simulate a minute-long shift
    // without sleeping and exercise in-window offline ingestion through HTTP.
    assert.ok(new Date(punchIn.body.data.punchedInAt).getTime() >= shiftStartedAt.getTime());
    await prisma.attendanceSession.update({
      where: { id: attendanceSessionId }, data: { punchedInAt: shiftStartedAt },
    });

    const eventId = randomUUID();
    const pingPayload = {
      sessionId: attendanceSessionId,
      latitude: 28.616,
      longitude: 77.211,
      accuracy: 20,
      capturedAt: new Date(shiftStartedAt.getTime() + 10_000).toISOString(),
      clientEventId: eventId,
      isMock: false,
    };
    const ping = await api
      .post('/api/v1/attendance/location-ping')
      .set('Authorization', employeeAuth)
      .send(pingPayload);
    assert.equal(ping.body.data.accepted, true);
    const duplicate = await api
      .post('/api/v1/attendance/location-ping')
      .set('Authorization', employeeAuth)
      .send(pingPayload);
    assert.equal(duplicate.body.data.reason, 'DUPLICATE');
    const concurrentEvent = {
      ...pingPayload,
      capturedAt: new Date(shiftStartedAt.getTime() + 20_000).toISOString(),
      clientEventId: randomUUID(),
    };
    const concurrentPings = await Promise.all([0, 1].map(() => api
      .post('/api/v1/attendance/location-ping')
      .set('Authorization', employeeAuth)
      .send(concurrentEvent)));
    assert.ok(concurrentPings.every((response) => response.status === 200
      && response.body.data.accepted === true));
    assert.equal(concurrentPings.filter((response) => response.body.data.reason === 'DUPLICATE').length, 1);
    assert.equal(await prisma.locationPing.count({
      where: { attendanceSessionId, clientEventId: concurrentEvent.clientEventId },
    }), 1);

    const live = await api
      .get('/api/v1/admin/live-locations')
      .set('Authorization', managerAuth);
    assert.equal(live.status, 200);
    assert.equal(live.body.data[0].presence, 'live');

    const punchOuts = await Promise.all([0, 1].map(() => api
      .post('/api/v1/attendance/punch-out')
      .set('Authorization', employeeAuth)
      .field('closingOdoKm', '1250.00')
      .field('latitude', '28.62')
      .field('longitude', '77.22')
      .field('capturedAt', new Date().toISOString())
      .attach('closingOdoImage', TINY_JPEG, { filename: 'closing.jpg', contentType: 'image/jpeg' })));
    assert.deepEqual(punchOuts.map((response) => response.status).sort(), [200, 409]);
    const punchOut = punchOuts.find((response) => response.status === 200);
    assert.equal(punchOut.status, 200);
    assert.equal(punchOut.body.data.status, 'punched_out');
    const closedSession = await prisma.attendanceSession.findUnique({ where: { id: attendanceSessionId } });
    await api.get(`/uploads/${closedSession.closingOdoImagePath}`)
      .set('Authorization', employeeAuth)
      .expect(200);

    const backfillPayload = {
      ...pingPayload,
      capturedAt: new Date(shiftStartedAt.getTime() + 40_000).toISOString(),
      clientEventId: randomUUID(),
    };
    const backfill = await api.post('/api/v1/attendance/location-ping')
      .set('Authorization', employeeAuth).send(backfillPayload).expect(200);
    assert.equal(backfill.body.data.accepted, true);
    const afterBackfill = await prisma.attendanceSession.findUnique({ where: { id: attendanceSessionId } });
    assert.equal(afterBackfill.pingCount, closedSession.pingCount + 1);
    assert.equal(afterBackfill.lastKnownCapturedAt.getTime(), closedSession.lastKnownCapturedAt.getTime());
    assert.equal(afterBackfill.lastKnownLatitude, closedSession.lastKnownLatitude);
    const tooCloseBackfill = await api.post('/api/v1/attendance/location-ping')
      .set('Authorization', employeeAuth)
      .send({
        ...backfillPayload,
        capturedAt: new Date(shiftStartedAt.getTime() + 42_000).toISOString(),
        clientEventId: randomUUID(),
      }).expect(200);
    assert.equal(tooCloseBackfill.body.data.reason, 'TOO_FREQUENT');

    const employeeCannotChangeSettings = await api
      .patch('/api/v1/admin/location-settings')
      .set('Authorization', employeeAuth)
      .send({ locationMode: 'single' });
    assert.equal(employeeCannotChangeSettings.status, 403);
    const settings = await api
      .patch('/api/v1/admin/location-settings')
      .set('Authorization', adminAuth)
      .send({ locationMode: 'single' });
    assert.equal(settings.status, 200);
    assert.equal(settings.body.data.locationMode, 'single');
    const repeatedBatch = await api.post('/api/v1/attendance/location-pings')
      .set('Authorization', employeeAuth)
      .send({ sessionId: attendanceSessionId, pings: [pingPayload] })
      .expect(200);
    assert.equal(repeatedBatch.body.data.acceptedCount, 1);
    assert.equal(repeatedBatch.body.data.items[0].reason, 'DUPLICATE');
    assert.equal(repeatedBatch.body.data.items[0].pingId, ping.body.data.pingId);

    const oldCookie = refreshCookie(employeeLogin);
    const refreshed = await api.post('/api/v1/auth/refresh').set('Cookie', oldCookie);
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshCookie(refreshed), oldCookie);
    const reuse = await api.post('/api/v1/auth/refresh').set('Cookie', oldCookie);
    assert.equal(reuse.status, 401);
    assert.equal(reuse.body.error.code, 'INVALID_REFRESH_TOKEN');
    const revokedAccess = await api.get('/api/v1/auth/me').set('Authorization', employeeAuth);
    assert.equal(revokedAccess.status, 401);
    assert.equal(revokedAccess.body.error.message, 'Access session is no longer active');

    // Failed passwords and role mismatches must commit lockout state even though
    // the endpoint returns an error, and the fifth failure must block a valid password.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await api.post('/api/v1/auth/login').send({
        userId: employeeEmployeeId,
        password: attempt === 0 ? 'Employee-pass-12' : 'Wrong-password-12',
        role: attempt === 0 ? 'MANAGER' : 'EMPLOYEE',
      });
      assert.equal(failed.status, 401);
      assert.deepEqual(failed.body.error, {
        code: 'INVALID_CREDENTIALS', message: 'Invalid user ID or password',
      });
    }
    const locked = await prisma.user.findUnique({ where: { id: employee.id } });
    assert.equal(locked.noOfAttempts, 5);
    assert.ok(locked.lockedUntil.getTime() > Date.now());
    await api.post('/api/v1/auth/login').send({
      userId: employeeEmployeeId, password: 'Employee-pass-12', role: 'EMPLOYEE',
    }).expect(401);
    await prisma.user.update({ where: { id: employee.id }, data: { lockedUntil: new Date(0) } });
    const unlocked = await api.post('/api/v1/auth/login').send({
      userId: employeeEmployeeId, password: 'Employee-pass-12', role: 'EMPLOYEE',
    }).expect(200);
    assert.equal((await prisma.user.findUnique({ where: { id: employee.id } })).noOfAttempts, 0);
    const simultaneousRefresh = await Promise.all([0, 1].map(() => api
      .post('/api/v1/auth/refresh').set('Cookie', refreshCookie(unlocked))));
    assert.deepEqual(simultaneousRefresh.map((response) => response.status).sort(), [200, 401]);
    await api.get('/api/v1/auth/me')
      .set('Authorization', bearer(simultaneousRefresh.find((response) => response.status === 200)))
      .expect(401);
    const currentLogin = await api.post('/api/v1/auth/login').send({
      userId: employeeEmployeeId, password: 'Employee-pass-12', role: 'EMPLOYEE',
    }).expect(200);
    // Current DB role, not the JWT role, must control every protected request.
    await prisma.user.update({ where: { id: employee.id }, data: { role: 'ADMIN' } });
    await api.get('/api/v1/admin/location-settings')
      .set('Authorization', bearer(currentLogin)).expect(200);
    await prisma.user.update({ where: { id: employee.id }, data: { isActive: false } });
    await api.get('/api/v1/auth/me').set('Authorization', bearer(currentLogin)).expect(401);

  });
}
