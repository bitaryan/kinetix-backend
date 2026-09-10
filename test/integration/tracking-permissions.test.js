import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import request from 'supertest';
import { attendanceDay } from '../../src/attendance/day.js';
import { createAutoPunchOut } from '../../src/attendance/auto-punch-out.js';
import { createApplication } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { createPrisma } from '../../src/db/prisma.js';
import { requireTestDatabaseUrl } from './database.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const photo = { filename: 'selfie.jpg', contentType: 'image/jpeg' };

if (!process.env.TEST_DATABASE_URL) {
  test('tracking and permissions require TEST_DATABASE_URL', { skip: true }, () => {});
} else {
  test('per-user tracking, punch snapshots and admin-only actions', async (t) => {
    const uploadDir = await mkdtemp(path.join(os.tmpdir(), 'gpss-tracking-'));
    const config = loadConfig({ APP_ENV: 'test', DATABASE_URL: requireTestDatabaseUrl(), UPLOAD_DIR: uploadDir,
      JWT_SECRET_KEY: 'tracking-integration-secret-0123456789', LOGIN_RATE_LIMIT_PER_MINUTE: '1000',
      LOCATION_PING_RATE_LIMIT_PER_MINUTE: '1000', LOCATION_PING_MIN_INTERVAL_SECONDS: '0', GEOFENCES_ENABLED: 'true' });
    const prisma = createPrisma(config);
    let attendanceClock = new Date(attendanceDay(new Date()).end.getTime() + 9 * 3600000);
    const app = createApplication({ config, prisma, attendanceNow: () => new Date(attendanceClock) });
    const api = request(app.app);
    const ids = [];
    const fences = [];
    const suffix = randomUUID().slice(0, 8).toUpperCase();
    const password = 'Tracking-password-123';
    const oldSettings = await prisma.locationSettings.findUnique({ where: { singletonKey: 'default' } });
    t.after(async () => {
      try {
        await prisma.geofence.deleteMany({ where: { id: { in: fences } } });
        await prisma.auditEvent.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { subjectId: { in: ids } }] } });
        await prisma.user.deleteMany({ where: { id: { in: ids } } });
        if (oldSettings) await prisma.locationSettings.update({ where: { singletonKey: 'default' }, data: { locationMode: oldSettings.locationMode } });
        else await prisma.locationSettings.deleteMany({ where: { singletonKey: 'default' } });
      } finally { app.liveHub.close(); await prisma.$disconnect(); await rm(uploadDir, { recursive: true, force: true }); }
    });
    await prisma.locationSettings.upsert({ where: { singletonKey: 'default' }, create: { singletonKey: 'default', locationMode: 'continuous' }, update: { locationMode: 'continuous' } });
    const admin = await app.auth.service.createUser({ userId: `ADM${suffix}`, employeeName: 'Admin', email: `${suffix}-admin@test.example`, password, role: 'ADMIN' }, { allowAdminRole: true });
    ids.push(admin.id);
    async function login(userId, role) {
      const response = await api.post('/api/v1/auth/login').send({ userId, role, password }).expect(200);
      return `Bearer ${response.body.data.accessToken}`;
    }
    const adminToken = await login(admin.employeeId, 'ADMIN');
    async function create(role, index, enabled) {
      const response = await api.post('/api/v1/auth/users').set('Authorization', adminToken).send({
        userId: `USR${suffix}${index}`, employeeName: role, email: `${suffix}-${index}@test.example`, password, role,
        ...(enabled === undefined ? {} : { locationTrackingEnabled: enabled }),
      }).expect(201);
      ids.push(response.body.data.id);
      const user = response.body.data;
      return { ...user, token: await login(user.userId, role) };
    }
    const employee = await create('EMPLOYEE', 1);
    const manager = await create('MANAGER', 2, true);
    const patchTracking = (enabled, token = adminToken) => api.patch(`/api/v2/users/${employee.id}`)
      .set('Authorization', token).send({ locationTrackingEnabled: enabled });
    const me = () => api.get('/api/v1/auth/me').set('Authorization', employee.token);
    const current = () => api.get('/api/v1/attendance/current').set('Authorization', employee.token);
    const open = (tracked = false) => {
      let req = api.post('/api/v1/attendance/punch-in').set('Authorization', employee.token)
        .field('latitude', '28.6').field('longitude', '77.2').attach('selfie', JPEG, photo);
      if (tracked) req = req.field('openingOdoKm', '100').attach('openingOdoImage', JPEG, photo);
      return req;
    };
    const close = () => api.post('/api/v1/attendance/punch-out').set('Authorization', employee.token).send({ latitude: 28.7, longitude: 77.3 });
    const ping = (sessionId, capturedAt = attendanceClock.toISOString()) => ({ sessionId, latitude: 28.61, longitude: 77.21, capturedAt, clientEventId: randomUUID() });
    const sendPing = (point) => api.post('/api/v1/attendance/location-ping').set('Authorization', employee.token).send(point);
    let untrackedSession;
    await t.test('admin controls the flag; new accounts default off and cannot enable themselves', async () => {
      assert.equal(employee.locationTrackingEnabled, false);
      assert.equal(manager.locationTrackingEnabled, true);
      assert.equal((await me().expect(200)).body.data.locationTrackingEnabled, false);
      for (const token of [manager.token, employee.token]) await patchTracking(true, token).expect(403);
      await api.patch('/api/v2/profile').set('Authorization', employee.token).send({ locationTrackingEnabled: true }).expect(422);
      await api.patch(`/api/v2/users/${employee.id}`).set('Authorization', adminToken).send({ locationTrackingEnabled: 'false' }).expect(422);
      const list = await api.get(`/api/v2/users?search=${suffix}`).set('Authorization', adminToken).expect(200);
      assert.equal(list.body.data.find((user) => user.id === employee.id).locationTrackingEnabled, false);
    });
    await t.test('off requires selfie and punch-in GPS, then only punch-out GPS; no odometers or live points', async () => {
      await api.post('/api/v1/attendance/punch-in').set('Authorization', employee.token).attach('selfie', JPEG, photo).expect(422);
      await api.post('/api/v1/attendance/punch-in').set('Authorization', employee.token).send({ latitude: 28, longitude: 77 }).expect(422);
      const response = await open().expect(201);
      untrackedSession = response.body.data.sessionId;
      assert.equal(response.body.data.openingOdoKm, null);
      assert.equal(response.body.data.locationTrackingEnabled, false);
      assert.equal(response.body.data.requiresOdometer, false);
      assert.equal((await current().expect(200)).body.data.requiresOdometer, false);
      const point = ping(untrackedSession);
      assert.equal((await sendPing(point).expect(200)).body.data.reason, 'LOCATION_TRACKING_DISABLED');
      const batch = await api.post('/api/v1/attendance/location-pings').set('Authorization', employee.token).send({ sessionId: untrackedSession, pings: [point, point] }).expect(200);
      assert.equal(batch.body.data.rejectedCount, 2);
      assert.ok(batch.body.data.items.every((item) => item.reason === 'LOCATION_TRACKING_DISABLED'));
      assert.equal((await app.liveHub.snapshot()).some((row) => row.userId === employee.id), false);
      await api.post('/api/v1/attendance/punch-out').set('Authorization', employee.token).send({}).expect(422);
      const blocked = await patchTracking(true).expect(409);
      assert.deepEqual(blocked.body.error, { code: 'ACTIVE_ATTENDANCE', message: "Can't change during working shift" });
      await patchTracking(false).expect(200); // An unchanged setting is idempotent.
      await close().expect(200);
      assert.equal((await open().expect(409)).body.error.code, 'ALREADY_PUNCHED_IN_TODAY');
      const stored = await prisma.attendanceSession.findUnique({ where: { id: untrackedSession } });
      for (const key of ['openingOdoKm', 'openingOdoImagePath', 'closingOdoKm', 'closingOdoImagePath', 'lastKnownCapturedAt']) assert.equal(stored[key], null);
      assert.equal(stored.pingCount, 0);
      assert.equal(stored.punchOutLatitude, 28.7);
      assert.equal(await prisma.locationPing.count({ where: { attendanceSessionId: untrackedSession } }), 0);
      const detail = await api.get(`/api/v2/attendance/${untrackedSession}`).set('Authorization', employee.token).expect(200);
      assert.equal(detail.body.data.distanceKm, null);
      assert.equal(detail.body.data.openingOdoImageUrl, null);
      assert.equal(detail.body.data.punchInLocation.latitude, 28.6);
      assert.equal(detail.body.data.punchOutLocation.latitude, 28.7);
    });
    await t.test('tracked shift locks the switch until 8 PM auto punch-out, without closing odometer or coordinates', async () => {
      attendanceClock = new Date(attendanceClock.getTime() + 86400000);
      await patchTracking(true).expect(200);
      await open().expect(422);
      const response = await open(true).expect(201);
      const sessionId = response.body.data.sessionId;
      const blocked = await patchTracking(false).expect(409);
      assert.deepEqual(blocked.body.error, { code: 'ACTIVE_ATTENDANCE', message: "Can't change during working shift" });
      assert.equal((await me().expect(200)).body.data.locationTrackingEnabled, true);
      assert.equal((await current().expect(200)).body.data.requiresOdometer, true);
      await close().expect(422);
      const events = [];
      const unsubscribe = app.liveHub.subscribe((event) => events.push(event));
      attendanceClock = attendanceDay(attendanceClock).cutoff;
      const counts = await Promise.all([app.attendance.autoPunchOut(), app.attendance.autoPunchOut()]);
      unsubscribe();
      assert.equal(counts.reduce((a, b) => a + b, 0), 1);
      assert.equal(events.filter((event) => event.status === 'punched_out').length, 1);
      const stored = await prisma.attendanceSession.findUnique({ where: { id: sessionId } });
      assert.equal(stored.autoPunchedOut, true);
      assert.equal(stored.punchedOutAt.toISOString(), attendanceClock.toISOString());
      for (const key of ['closingOdoKm', 'closingOdoImagePath', 'punchOutLatitude', 'punchOutLongitude']) assert.equal(stored[key], null);
      assert.equal((await current().expect(200)).body.data.punchedIn, false);
      assert.equal((await app.liveHub.snapshot()).some((row) => row.userId === employee.id), false);
      assert.equal((await open(true).expect(409)).body.error.code, 'ALREADY_PUNCHED_IN_TODAY');
      const detail = await api.get(`/api/v2/attendance/${sessionId}`).set('Authorization', adminToken).expect(200);
      assert.equal(detail.body.data.punchOutLabel, 'Auto punch out');
      assert.equal(detail.body.data.autoPunchedOut, true);
      assert.equal(detail.body.data.distanceKm, null);
      const day = attendanceClock.toISOString().slice(0, 10);
      const query = `from=${day}&to=${day}&userId=${employee.id}`;
      const history = await api.get(`/api/v2/attendance?${query}`).set('Authorization', adminToken).expect(200);
      assert.equal(history.body.data[0].punchOutLabel, 'Auto punch out');
      const report = await api.get(`/api/v2/reports/attendance?${query}`).set('Authorization', adminToken).expect(200);
      assert.equal(report.body.data.sessions[0].punchOutLabel, 'Auto punch out');
      const csv = await api.get(`/api/v2/attendance/export?${query}`).set('Authorization', adminToken).expect(200);
      assert.match(csv.text, /Auto punch out/);
      await patchTracking(false).expect(200);
    });
    await t.test('next India day allows one new punch-in under concurrent requests and manual close preserves its label', async () => {
      attendanceClock = new Date(attendanceDay(attendanceClock).end.getTime() + 9 * 3600000);
      const responses = await Promise.all([open(), open()]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
      const sessionId = responses.find((response) => response.status === 201).body.data.sessionId;
      await close().expect(200);
      assert.equal((await open().expect(409)).body.error.code, 'ALREADY_PUNCHED_IN_TODAY');
      const detail = await api.get(`/api/v2/attendance/${sessionId}`).set('Authorization', adminToken).expect(200);
      assert.equal(detail.body.data.autoPunchedOut, false);
      assert.equal(detail.body.data.punchOutLabel, null);
      await patchTracking(true).expect(200);
    });
    await t.test('manager still on shift is auto punched out after downtime without changing completed shifts', async () => {
      const response = await api.post('/api/v1/attendance/punch-in').set('Authorization', manager.token)
        .field('latitude', '28.6').field('longitude', '77.2').field('openingOdoKm', '100')
        .attach('selfie', JPEG, photo).attach('openingOdoImage', JPEG, photo).expect(201);
      const cutoff = attendanceDay(attendanceClock).cutoff;
      attendanceClock = new Date(attendanceClock.getTime() + 86400000);
      assert.equal(await app.attendance.autoPunchOut(), 1);
      const row = await prisma.attendanceSession.findUnique({ where: { id: response.body.data.sessionId } });
      assert.equal(row.autoPunchedOut, true);
      assert.equal(row.punchedOutAt.toISOString(), cutoff.toISOString());
      const employeeRows = await prisma.attendanceSession.findMany({ where: { userId: employee.id, autoPunchedOut: false } });
      assert.equal(employeeRows.length, 2);
    });
    await t.test('manual and automatic punch-out race commits exactly one closing outcome', async () => {
      await patchTracking(false).expect(200);
      const response = await open().expect(201);
      const sessionId = response.body.data.sessionId;
      const cutoff = attendanceDay(attendanceClock).cutoff;
      attendanceClock = new Date(cutoff.getTime() - 1);
      const automatic = createAutoPunchOut({ prisma, liveHub: app.liveHub, now: () => cutoff });
      const [manual, auto] = await Promise.allSettled([
        app.attendance.punchOut(employee.id, { latitude: 28.7, longitude: 77.3, accuracy: null }),
        automatic(),
      ]);
      assert.equal(auto.status, 'fulfilled');
      const row = await prisma.attendanceSession.findUnique({ where: { id: sessionId } });
      assert.equal(row.status, 'punched_out');
      if (manual.status === 'fulfilled') {
        assert.equal(auto.value, 0);
        assert.equal(row.autoPunchedOut, false);
        assert.equal(row.punchOutLatitude, 28.7);
        assert.equal(row.punchedOutAt.toISOString(), attendanceClock.toISOString());
      } else {
        assert.equal(manual.reason.code, 'NOT_PUNCHED_IN');
        assert.equal(auto.value, 1);
        assert.equal(row.autoPunchedOut, true);
        assert.equal(row.punchOutLatitude, null);
        assert.equal(row.punchedOutAt.toISOString(), cutoff.toISOString());
      }
    });
    await t.test('tracking toggle racing with punch-in cannot change requirements on an active shift', async () => {
      attendanceClock = new Date(attendanceDay(attendanceClock).end.getTime() + 9 * 3600000);
      await patchTracking(true).expect(200);
      const [opened, toggled] = await Promise.all([open(true), patchTracking(false)]);
      assert.equal(opened.status, 201);
      assert.ok([200, 409].includes(toggled.status));
      const user = await prisma.user.findUnique({ where: { id: employee.id } });
      const row = await prisma.attendanceSession.findUnique({ where: { id: opened.body.data.sessionId } });
      assert.equal(row.openingOdoKm != null, user.locationTrackingEnabled);
      if (toggled.status === 409) assert.equal(toggled.body.error.code, 'ACTIVE_ATTENDANCE');
      attendanceClock = attendanceDay(attendanceClock).cutoff;
      await app.attendance.autoPunchOut();
    });
    await t.test('managers cannot approve/reject any leave or delete any client log', async () => {
      for (const [index, person] of [employee, manager].entries()) {
        const leave = await api.post('/api/v1/leaves').set('Authorization', person.token)
          .send({ start_date: `2027-10-0${index + 1}`, end_date: `2027-10-0${index + 1}`, reason: 'Leave' }).expect(201);
        for (const status of ['APPROVED', 'REJECTED']) {
          await api.patch(`/api/v1/leaves/${leave.body.data.id}/status`).set('Authorization', manager.token)
            .send({ status, rejection_reason: status === 'REJECTED' ? 'Reason' : null }).expect(403);
        }
        assert.equal((await prisma.leave.findUnique({ where: { id: leave.body.data.id } })).status, 'PENDING');
        await api.patch(`/api/v1/leaves/${leave.body.data.id}/status`).set('Authorization', adminToken).send({ status: 'APPROVED' }).expect(200);
        const log = await api.post('/api/v1/client-logs').set('Authorization', person.token).field('client_name', 'Client')
          .field('company_name', 'Company').field('mobile_number', '9876543210').field('mail_id', 'client@test.example').field('date', '2026-09-06').expect(201);
        await api.delete(`/api/v1/client-logs/${log.body.data.id}`).set('Authorization', manager.token).expect(403);
        assert.equal(await prisma.clientLog.count({ where: { id: log.body.data.id } }), 1);
        await api.delete(`/api/v1/client-logs/${log.body.data.id}`).set('Authorization', adminToken).expect(200);
      }
      const managerNotes = await api.get('/api/v2/notifications').set('Authorization', manager.token).expect(200);
      assert.equal(managerNotes.body.data.some((note) => note.type === 'leave.applied'), false);
    });
  });
}
