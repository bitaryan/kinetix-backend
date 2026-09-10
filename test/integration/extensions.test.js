import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import request from 'supertest';
import { attendanceDay } from '../../src/attendance/day.js';
import { createApplication } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { createPrisma } from '../../src/db/prisma.js';
import { createDeliveryWorker } from '../../src/workflows/delivery.js';
import { decryptPayload, encryptPayload } from '../../src/workflows/events.js';
import { runRetention } from '../../src/operations/retention.js';
import { requireTestDatabaseUrl } from './database.js';

if (!process.env.TEST_DATABASE_URL) {
  test('V2 extensions require TEST_DATABASE_URL', { skip: true }, () => {});
} else {
  const databaseUrl = requireTestDatabaseUrl();
  test('backend extensions enforce contracts, transactions, ownership and durable delivery', async (t) => {
    const config = loadConfig({ APP_ENV: 'test', JWT_SECRET_KEY: 'extensions-integration-secret-0123456789', DATABASE_URL: databaseUrl,
      LOGIN_RATE_LIMIT_PER_MINUTE: '1000', GEOFENCES_ENABLED: 'true', METRICS_TOKEN: 'test-metrics-token-01234567890123456789' });
    const prisma = createPrisma(config);
    const day = attendanceDay(new Date());
    // Keep the geofence fixture within one open India shift, even on night CI runs.
    const attendanceTime = new Date(day.end.getTime() + 9 * 3600000);
    const app = createApplication({ config, prisma, attendanceNow: () => attendanceTime });
    const server = app.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const api = request(server);
    const suffix = randomUUID().slice(0, 8).toUpperCase();
    const password = 'Integration-password-123';
    const ids = [];
    const jobIds = [];
    const fenceIds = [];
    const holidayIds = [];
    const oldPolicy = await prisma.workforcePolicy.findUnique({ where: { key: 'default' } });
    t.after(async () => {
      try {
        await prisma.deliveryJob.deleteMany({ where: { id: { in: jobIds } } });
        await prisma.geofence.deleteMany({ where: { id: { in: fenceIds } } });
        await prisma.holiday.deleteMany({ where: { id: { in: holidayIds } } });
        await prisma.auditEvent.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { subjectId: { in: ids } }] } });
        await prisma.user.deleteMany({ where: { id: { in: ids } } });
        if (oldPolicy) await prisma.workforcePolicy.upsert({ where: { key: 'default' }, create: oldPolicy, update: oldPolicy });
        else await prisma.workforcePolicy.deleteMany({ where: { key: 'default' } });
      } finally {
        await new Promise((resolve) => server.close(resolve));
        app.liveHub.close(); await prisma.$disconnect();
      }
    });
    async function create(role, index) {
      const user = await app.auth.service.createUser({ userId: `${role.slice(0, 3)}${suffix}${index}`, employeeName: `${role} test`,
        email: `${suffix}-${index}@extensions-test.example.com`, password, role, locationTrackingEnabled: true }, { allowAdminRole: true });
      ids.push(user.id);
      return user;
    }
    async function login(user, pass = password, target = api) {
      const response = await target.post('/api/v1/auth/login').send({ userId: user.employeeId, role: user.role, password: pass }).expect(200);
      return `Bearer ${response.body.data.accessToken}`;
    }
    const admin = await create('ADMIN', 1);
    const manager = await create('MANAGER', 2);
    const employee = await create('EMPLOYEE', 3);
    const other = await create('EMPLOYEE', 4);
    const adminToken = await login(admin);
    const managerToken = await login(manager);
    let employeeToken = await login(employee);
    const otherToken = await login(other);
    const get = (url, token = employeeToken) => api.get(url).set('Authorization', token);

    await t.test('all new protected endpoints authenticate before parsing and enforce supervisor roles', async () => {
      for (const url of ['/attendance', '/attendance/export', `/attendance/${randomUUID()}`, `/attendance/${randomUUID()}/trail`,
        '/reports/attendance', '/dashboard', '/users', '/leaves', '/leaves/balance', '/holidays', '/policy', '/notifications', '/audit-events', '/geofences']) {
        await api.get(`/api/v2${url}`).expect(401);
      }
      for (const url of ['/users', '/audit-events', '/geofences', '/reports/attendance', '/dashboard']) await get(`/api/v2${url}`).expect(403);
      for (const url of ['/users', '/audit-events']) await get(`/api/v2${url}`, managerToken).expect(403);
      await api.patch('/api/v2/profile').set('Content-Type', 'application/json').send('{').expect(401);
      await api.post('/api/v2/auth/reset-password').set('Content-Type', 'application/json').send('{').expect(422);
    });

    await t.test('user search, atomic bulk creation, safe profile fields, access changes and session revocation', async () => {
      const users = await get(`/api/v2/users?search=${suffix}`, adminToken).expect(200);
      assert.equal(users.body.data.length, 4);
      assert.equal(JSON.stringify(users.body).includes('passwordHash'), false);
      assert.deepEqual(Object.keys(users.body.meta), ['page', 'limit', 'total', 'totalPages']);
      await get(`/api/v2/users/${employee.id}`, adminToken).expect(200);
      await get(`/api/v2/users/${randomUUID()}`, adminToken).expect(404);
      const payload = { userId: `BULK${suffix}`, employeeName: 'Bulk employee', email: `${suffix}-bulk@extensions-test.example.com`, password };
      await api.post('/api/v2/users/bulk').set('Authorization', adminToken).send({ users: [payload, { ...payload, userId: `BULK2${suffix}`, email: admin.email }] }).expect(409);
      assert.equal(await prisma.user.count({ where: { employeeId: payload.userId } }), 0);
      const bulk = await api.post('/api/v2/users/bulk').set('Authorization', adminToken).send({ users: [payload] }).expect(201);
      ids.push(bulk.body.data[0].id);
      await api.post('/api/v2/users/bulk').set('Authorization', adminToken).send({ users: [{ ...payload, role: 'ADMIN' }] }).expect(403);
      await api.patch('/api/v2/profile').set('Authorization', employeeToken).send({ role: 'ADMIN' }).expect(422);
      await api.patch('/api/v2/profile').set('Authorization', employeeToken).send({ employeeName: 'Updated employee' }).expect(200);
      await api.patch('/api/v2/profile').set('Authorization', employeeToken).send({ email: 'new@example.com', currentPassword: 'Wrong-pass-123' }).expect(401);
      await api.patch(`/api/v2/users/${admin.id}`).set('Authorization', adminToken).send({ isActive: false }).expect(403);
      await api.patch(`/api/v2/users/${employee.id}`).set('Authorization', adminToken).send({ isActive: false }).expect(200);
      await get('/api/v1/auth/me').expect(401);
      await api.patch(`/api/v2/users/${employee.id}`).set('Authorization', adminToken).send({ isActive: true }).expect(200);
      employeeToken = await login(employee);
    });

    const sessionData = { userId: employee.id, status: 'punched_out', openingOdoKm: '100.10', closingOdoKm: '125.25',
      openingSelfiePath: `attendance/${employee.id}/test/selfie.jpg`, openingOdoImagePath: `attendance/${employee.id}/test/odo.jpg`,
      punchInLatitude: 0, punchInLongitude: 0, punchedInAt: new Date('2026-09-01T08:00Z'), punchedOutAt: new Date('2026-09-01T17:00Z') };
    const session = await prisma.attendanceSession.create({ data: sessionData });
    await prisma.locationPing.createMany({ data: [
      { attendanceSessionId: session.id, latitude: 1, longitude: 2, capturedAt: new Date('2026-09-01T08:00Z') },
      { attendanceSessionId: session.id, latitude: 1.1, longitude: 2.1, capturedAt: new Date('2026-09-01T09:00Z') },
    ] });
    await t.test('attendance history, stable trail pages, report, dashboard, CSV and PDF honor ownership', async () => {
      const history = await get('/api/v2/attendance?from=2026-09-01&to=2026-09-05').expect(200);
      assert.equal(history.body.data.length, 1);
      assert.equal(history.body.data[0].distanceKm, '25.15');
      assert.equal(history.body.data[0].workedMinutes, 540);
      await get(`/api/v2/attendance?userId=${other.id}`).expect(404);
      await get(`/api/v2/attendance/${session.id}`, otherToken).expect(404);
      await get(`/api/v2/attendance/${session.id}/trail`, otherToken).expect(404);
      await get(`/api/v2/attendance/${session.id}`, managerToken).expect(200);
      const first = await get(`/api/v2/attendance/${session.id}/trail?limit=1`).expect(200);
      const second = await get(`/api/v2/attendance/${session.id}/trail?limit=1&page=2`).expect(200);
      assert.equal(first.body.meta.total, 2);
      assert.notEqual(first.body.data[0].id, second.body.data[0].id);
      await get('/api/v2/attendance?page=invalid').expect(422);
      const query = `from=2026-09-01&to=2026-09-05&userId=${employee.id}`;
      const report = await get(`/api/v2/reports/attendance?${query}`, managerToken).expect(200);
      assert.equal(report.body.data.summaries[0].workedMinutes, 540);
      const csv = await get(`/api/v2/attendance/export?${query}`).expect(200);
      assert.match(csv.text, /25.15/);
      assert.match(csv.headers['content-disposition'], /attendance.csv/);
      const pdf = await get(`/api/v2/attendance/export?format=pdf&${query}`).expect('Content-Type', /application\/pdf/).expect(200);
      assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
      const dashboard = await get(`/api/v2/dashboard?${query}`, managerToken).expect(200);
      assert.equal(dashboard.body.data.attendanceSessions, 1);
    });

    let leave;
    await t.test('leave policy, balances, cancellation races, history and private notifications', async () => {
      await get('/api/v2/policy').expect(200);
      await api.put('/api/v2/policy').set('Authorization', employeeToken).send({ weekendDays: [0, 6], dailyOvertimeMinutes: 480 }).expect(403);
      await api.put('/api/v2/policy').set('Authorization', adminToken).send({ weekendDays: [0, 6], dailyOvertimeMinutes: 480 }).expect(200);
      const holiday = await api.put('/api/v2/holidays').set('Authorization', adminToken).send({ date: '2027-04-06', name: `Holiday ${suffix}` }).expect(200);
      holidayIds.push(holiday.body.data.id);
      const holidays = await get('/api/v2/holidays?year=2027').expect(200);
      assert.ok(holidays.body.data.some((item) => item.id === holiday.body.data.id));
      await api.put(`/api/v2/users/${employee.id}/leave-entitlement`).set('Authorization', adminToken).send({ year: 2027, days: 20 }).expect(200);
      await api.put(`/api/v2/users/${employee.id}/leave-entitlement`).set('Authorization', adminToken).send({ year: 2027, days: -1 }).expect(422);
      const applied = await api.post('/api/v1/leaves').set('Authorization', employeeToken).send({ start_date: '2027-04-05', end_date: '2027-04-09', reason: 'Vacation' }).expect(201);
      leave = applied.body.data;
      const balance = await get('/api/v2/leaves/balance?year=2027').expect(200);
      assert.equal(balance.body.data.pendingDays, 4);
      assert.equal(balance.body.data.availableDays, 16);
      await get(`/api/v2/leaves/balance?userId=${other.id}`).expect(404);
      await api.post(`/api/v2/leaves/${leave.id}/cancel`).set('Authorization', otherToken).send({}).expect(404);
      const race = await Promise.all([
        api.patch(`/api/v1/leaves/${leave.id}/status`).set('Authorization', adminToken).send({ status: 'APPROVED' }),
        api.post(`/api/v2/leaves/${leave.id}/cancel`).set('Authorization', employeeToken).send({ reason: 'Changed plans' }),
      ]);
      assert.equal(race[1].status, 200);
      assert.ok([200, 409].includes(race[0].status));
      assert.equal((await prisma.leave.findUnique({ where: { id: leave.id } })).status, 'CANCELLED');
      const history = await get(`/api/v2/leaves/${leave.id}/history`).expect(200);
      assert.ok(history.body.data.some((event) => event.action === 'leave.cancelled'));
      await get(`/api/v2/leaves/${leave.id}/history`, otherToken).expect(404);
      const cancelled = await get('/api/v2/leaves?status=CANCELLED').expect(200);
      assert.equal(cancelled.body.data[0].id, leave.id);
      await get('/api/v1/leaves?status=CANCELLED').expect(422);
      const notes = await get('/api/v2/notifications?unread=true').expect(200);
      assert.ok(notes.body.data.length > 0);
      const noteId = notes.body.data[0].id;
      await api.patch(`/api/v2/notifications/${noteId}/read`).set('Authorization', otherToken).send({}).expect(404);
      await api.patch(`/api/v2/notifications/${noteId}/read`).set('Authorization', employeeToken).send({}).expect(200);
      await api.delete(`/api/v2/holidays/${holidayIds[0]}`).set('Authorization', adminToken).expect(200);
      await api.delete(`/api/v2/holidays/${holidayIds[0]}`).set('Authorization', adminToken).expect(404);
      const report = await get(`/api/v2/reports/attendance?from=2026-09-01&to=2026-09-05&userId=${employee.id}`, managerToken).expect(200);
      assert.equal(Object.hasOwn(report.body.data.summaries[0], 'overtimeMinutes'), false);
      assert.equal(Object.hasOwn(report.body.data, 'dailyOvertimeMinutes'), false);
      const adminReport = await get(`/api/v2/reports/attendance?from=2026-09-01&to=2026-09-05&userId=${employee.id}`, adminToken).expect(200);
      assert.equal(adminReport.body.data.summaries[0].overtimeMinutes, 60);
    });

    await t.test('geofence alerts are atomic with GPS ingestion and duplicate retries do not alert twice', async () => {
      const fence = await api.post('/api/v2/geofences').set('Authorization', adminToken).send({ name: `Site ${suffix}`, latitude: 0, longitude: 0, radiusMeters: 200 }).expect(201);
      fenceIds.push(fence.body.data.id);
      await get('/api/v2/geofences', managerToken).expect(200);
      const now = attendanceTime.getTime();
      const active = await prisma.attendanceSession.create({ data: { ...sessionData, status: 'punched_in', closingOdoKm: null,
        punchedInAt: new Date(now - 3600000), punchedOutAt: null, lastKnownCapturedAt: new Date(now - 3000000), lastKnownLatitude: 0, lastKnownLongitude: 0 } });
      await api.patch(`/api/v2/users/${employee.id}`).set('Authorization', adminToken).send({ isActive: false }).expect(409);
      const ping = (latitude, offset) => ({ sessionId: active.id, latitude, longitude: 0, accuracy: 5, capturedAt: new Date(now + offset).toISOString(), clientEventId: randomUUID() });
      await api.post('/api/v1/attendance/location-ping').set('Authorization', employeeToken).send(ping(0, -50000)).expect(200);
      const outside = ping(0.01, -30000);
      const results = await Promise.all([1, 2].map(() => api.post('/api/v1/attendance/location-ping').set('Authorization', employeeToken).send(outside)));
      assert.ok(results.every((result) => result.status === 200 && result.body.data.accepted));
      assert.equal(await prisma.auditEvent.count({ where: { resourceId: fence.body.data.id, action: 'geofence.exited' } }), 1);
      await api.post('/api/v1/attendance/location-ping').set('Authorization', employeeToken).send(ping(0, -40000)).expect(200);
      assert.equal(await prisma.auditEvent.count({ where: { resourceId: fence.body.data.id, action: 'geofence.entered' } }), 0);
      await api.put(`/api/v2/geofences/${fence.body.data.id}`).set('Authorization', adminToken).send({ name: `Site ${suffix}`, latitude: 0, longitude: 0, radiusMeters: 200, isActive: false }).expect(200);
      const audit = await get(`/api/v2/audit-events?resourceId=${fence.body.data.id}`, adminToken).expect(200);
      assert.ok(audit.body.data.length >= 3);
      await prisma.attendanceSession.update({ where: { id: active.id }, data: { status: 'punched_out', punchedOutAt: new Date() } });
    });

    await t.test('password changes and single-use resets revoke sessions; reset delivery is encrypted and leased', async () => {
      await api.post('/api/v2/auth/forgot-password').send({ userId: employee.employeeId }).expect(503);
      await api.post('/api/v2/auth/change-password').set('Authorization', employeeToken).send({ currentPassword: 'Bad-password-123', newPassword: 'New-password-123' }).expect(401);
      await api.post('/api/v2/auth/change-password').set('Authorization', employeeToken).send({ currentPassword: password, newPassword: 'New-password-123' }).expect(200);
      await get('/api/v1/auth/me').expect(401);
      employeeToken = await login(employee, 'New-password-123');
      const deliveryConfig = { ...config, notificationWebhookUrl: 'https://delivery-test.example.com', notificationWebhookSecret: 'integration-webhook-secret-0123456789',
        deliveryEncryptionKey: 'ab'.repeat(32), passwordResetUrl: 'https://client.example.com/reset' };
      const deliveryApp = createApplication({ config: deliveryConfig, prisma });
      const deliveryServer = deliveryApp.app.listen(0, '127.0.0.1');
      await once(deliveryServer, 'listening');
      t.after(async () => {
        await new Promise((resolve) => deliveryServer.close(resolve));
        deliveryApp.liveHub.close();
      });
      const resetApi = request(deliveryServer);
      const unknown = await resetApi.post('/api/v2/auth/forgot-password').send({ userId: 'UNKNOWN' }).expect(202);
      const known = await resetApi.post('/api/v2/auth/forgot-password').send({ userId: employee.employeeId }).expect(202);
      assert.deepEqual(unknown.body, known.body);
      const pending = (await prisma.deliveryJob.findMany({ where: { type: 'password.reset', deliveredAt: null, failedAt: null } }))
        .filter((job) => decryptPayload(job.payload, deliveryConfig.deliveryEncryptionKey).email === employee.email);
      assert.equal(pending.length, 1);
      const job = pending[0]; jobIds.push(job.id);
      assert.equal(JSON.stringify(job).includes(employee.email), false);
      const payload = decryptPayload(job.payload, deliveryConfig.deliveryEncryptionKey);
      let sends = 0;
      const fetcher = async (url, options) => {
        sends += 1;
        assert.equal(url, deliveryConfig.notificationWebhookUrl);
        assert.equal(options.headers['Idempotency-Key'], job.id);
        const signature = createHmac('sha256', deliveryConfig.notificationWebhookSecret).update(`${options.headers['X-GPSS-Timestamp']}.${options.body}`).digest('hex');
        assert.equal(options.headers['X-GPSS-Signature'], signature);
        return { ok: true, body: { cancel: async () => {} } };
      };
      const worker = createDeliveryWorker({ prisma, config: deliveryConfig, fetcher });
      await Promise.all([worker.runOne(), worker.runOne()]);
      assert.equal(sends, 1);
      assert.deepEqual((await prisma.deliveryJob.findUnique({ where: { id: job.id } })).payload, {});
      const token = new URLSearchParams(new URL(payload.resetUrl).hash.slice(1)).get('token');
      const results = await Promise.all([1, 2].map(() => resetApi.post('/api/v2/auth/reset-password').send({ token, newPassword: 'Reset-password-123' })));
      assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
      await get('/api/v1/auth/me').expect(401);
      employeeToken = await login(employee, 'Reset-password-123');

      const expiredJob = await prisma.deliveryJob.create({ data: { type: 'password.reset',
        payload: encryptPayload(payload, deliveryConfig.deliveryEncryptionKey) } });
      jobIds.push(expiredJob.id);
      await worker.runOne();
      assert.equal(sends, 1);
      assert.ok((await prisma.deliveryJob.findUnique({ where: { id: expiredJob.id } })).failedAt);
      await prisma.deliveryJob.updateMany({ where: { id: { in: jobIds } }, data: { deliveredAt: new Date('2001-01-01Z') } });
      const preview = await runRetention(prisma);
      assert.ok(preview.counts.deliveryJob >= 2);
      assert.equal(await prisma.deliveryJob.count({ where: { id: { in: jobIds } } }), 2);
    });

    await t.test('forward migration enforces extension constraints without weakening the baseline', async () => {
      await assert.rejects(prisma.leaveEntitlement.create({ data: { userId: other.id, year: 2027, days: -1 } }), /chk_leave_entitlement/);
      await assert.rejects(prisma.geofence.create({ data: { name: 'Invalid', latitude: 91, longitude: 0, radiusMeters: 50 } }), /chk_geofence_coordinates/);
      await assert.rejects(prisma.workforcePolicy.update({ where: { key: 'default' }, data: { dailyOvertimeMinutes: 0 } }), /chk_workforce_policy/);
      await get('/metrics', adminToken).expect(401);
      await get('/metrics', `Bearer ${config.metricsToken}`).expect(200);
    });
  });
}
