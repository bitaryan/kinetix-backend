import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
import request from 'supertest';
import { createApplication } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dateRange, userScope, strictBody } from '../../src/common/v2.js';
import { createTelemetry } from '../../src/operations/telemetry.js';
import { runRetention } from '../../src/operations/retention.js';
import { summarizeAttendance, createReportingService } from '../../src/reporting/service.js';
import { attendanceCsv, attendancePdf, csvCell } from '../../src/reporting/export.js';
import { countedLeaveDays, distanceMeters, createWorkflowService } from '../../src/workflows/service.js';
import { decryptPayload, encryptPayload } from '../../src/workflows/events.js';
import { createDeliveryWorker } from '../../src/workflows/delivery.js';

const secret = 'unit-extension-test-secret-0123456789';
const userId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';

test('V2 ranges, ownership and strict mutation fields reject ambiguous input', () => {
  assert.equal(dateRange({ from: '2026-01-01', to: '2026-12-31' }).until.toISOString(), '2027-01-01T00:00:00.000Z');
  for (const query of [{ from: '2026-02-30' }, { from: '2026-02-02', to: '2026-02-01' }, { from: '2024-01-01', to: '2026-01-01' }, { from: ['2026-01-01'] }]) assert.throws(() => dateRange(query), { status: 422 });
  assert.equal(userScope({ id: userId, role: 'EMPLOYEE' }), userId);
  assert.throws(() => userScope({ id: userId, role: 'EMPLOYEE' }, otherId), { status: 404 });
  assert.throws(() => strictBody({ role: 'ADMIN' }, ['name']), { status: 422 });
});

test('leave day accounting clips cross-year ranges and excludes configured weekends/holidays', () => {
  const start = new Date('2025-12-30Z');
  const end = new Date('2026-01-05Z');
  assert.equal(countedLeaveDays(start, end, 2026), 5);
  assert.equal(countedLeaveDays(start, end, 2026, [0, 6], [new Date('2026-01-01Z')]), 2);
  assert.equal(countedLeaveDays(start, end, 2024), 0);
  assert.equal(countedLeaveDays(new Date('2024-02-28Z'), new Date('2024-03-01Z'), 2024), 3);
});

test('overtime sums split shifts per UTC day, handles midnight and excludes open shifts', () => {
  const base = { userId, user: { employeeId: 'EMP', employeeName: 'Staff' }, openingOdoKm: '100', closingOdoKm: '100.10' };
  const rows = [
    { ...base, punchedInAt: new Date('2026-09-01T08:00Z'), punchedOutAt: new Date('2026-09-01T12:00Z') },
    { ...base, punchedInAt: new Date('2026-09-01T13:00Z'), punchedOutAt: new Date('2026-09-01T18:00Z') },
    { ...base, punchedInAt: new Date('2026-09-02T23:00Z'), punchedOutAt: new Date('2026-09-03T01:00Z') },
    { ...base, closingOdoKm: null, punchedInAt: new Date('2026-09-03T08:00Z'), punchedOutAt: null },
  ];
  const result = summarizeAttendance(rows, 480)[0];
  assert.equal(result.workedMinutes, 660);
  assert.equal(result.overtimeMinutes, 60);
  assert.equal(result.distanceKm, '0.30');
  assert.equal(result.openSessions, 1);
  assert.equal(summarizeAttendance(rows, null)[0].overtimeMinutes, null);
});

test('CSV neutralizes formulas and escaped cells; PDF produces a complete export', async () => {
  for (const value of ['=SUM(A1)', '  =HYPERLINK("bad")', '+1', '-1', '@formula', '\ttext']) assert.match(csvCell(value), /^"'/);
  assert.equal(csvCell('a,"b"\nc'), '"a,""b""\nc"');
  const report = { range: { from: '2026-09-01', to: '2026-09-05' }, sessions: [], summaries: [] };
  assert.match(attendanceCsv(report), /workedMinutes/);
  const pdf = await attendancePdf(report);
  assert.match(pdf.toString('ascii', 0, 8), /%PDF-/);
  assert.match(pdf.toString('ascii').slice(-30), /%%EOF/);
});

test('overtime is admin-only across reports, policy and PDF; untracked attendance has no invented distance', async () => {
  const row = { id: userId, userId, user: { employeeId: 'EMP', employeeName: 'Staff' }, status: 'punched_out',
    punchedInAt: new Date('2026-09-01T08:00Z'), punchedOutAt: new Date('2026-09-01T17:00Z'),
    openingOdoKm: null, closingOdoKm: null, openingSelfiePath: 'selfie.jpg', openingOdoImagePath: null,
    punchInLatitude: 28, punchInLongitude: 77, punchOutLatitude: 29, punchOutLongitude: 78, pingCount: 0 };
  const prisma = { attendanceSession: { findMany: async () => [row] },
    workforcePolicy: { findUnique: async () => ({ key: 'default', weekendDays: [0], dailyOvertimeMinutes: 480 }) },
    $transaction: async (operation) => operation(prisma) };
  const reporting = createReportingService({ prisma });
  const workflow = createWorkflowService({ prisma, config: {} });
  for (const role of ['ADMIN', 'MANAGER', 'EMPLOYEE']) {
    const actor = { id: userId, role };
    const report = await reporting.report(actor, { from: '2026-09-01', to: '2026-09-01' });
    const policy = await workflow.policy(actor);
    const admin = role === 'ADMIN';
    assert.equal(Object.hasOwn(report, 'dailyOvertimeMinutes'), admin);
    assert.equal(Object.hasOwn(policy, 'dailyOvertimeMinutes'), admin);
    assert.equal(Object.hasOwn(report.summaries[0], 'overtimeMinutes'), admin);
    if (admin) assert.equal(report.summaries[0].overtimeMinutes, 60);
    assert.equal(report.summaries[0].distanceKm, null);
    assert.equal(report.sessions[0].openingOdoImageUrl, null);
    // PDFKit encodes Helvetica content as hex strings in Flate-compressed streams.
    const pdf = (await attendancePdf(report)).toString('latin1');
    const text = [...pdf.matchAll(/\/Filter \/FlateDecode\s*>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g)]
      .flatMap((match) => [...inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1').matchAll(/<([\da-f]+)>/gi)]
        .map((hex) => Buffer.from(hex[1], 'hex').toString('latin1'))).join('');
    assert.match(text, /GPSS/);
    assert.equal(/Overtime/i.test(text), admin);
    assert.match(text, /Distance not recorded/);
  }
});

test('delivery payloads are authenticated and secrets never stored as plaintext', () => {
  const key = 'ab'.repeat(32);
  const payload = { resetUrl: 'https://example.com/reset#token=private-secret', email: 'private@example.com' };
  const encrypted = encryptPayload(payload, key);
  assert.equal(JSON.stringify(encrypted).includes('private'), false);
  assert.deepEqual(decryptPayload(encrypted, key), payload);
  assert.throws(() => decryptPayload({ ...encrypted, tag: '00'.repeat(16) }, key));
  assert.throws(() => decryptPayload(encrypted, 'cd'.repeat(32)));
});

test('metrics and logs redact raw paths, incoming trace IDs, credentials and bodies', async () => {
  const logs = [];
  const telemetry = createTelemetry({ log: (entry) => logs.push(entry) });
  const config = loadConfig({ JWT_SECRET_KEY: secret, METRICS_TOKEN: 'test-metric-secret-1234567890123456789' });
  const app = createApplication({ config, prisma: {}, telemetry }).app;
  const api = request(app);
  await api.get('/metrics').expect(401);
  await api.get('/untrusted-path-secret?token=private').set('Authorization', 'Bearer private').expect(401);
  const health = await api.get('/livez').set('X-Request-ID', 'private').set('Traceparent', 'private').expect(200);
  assert.notEqual(health.headers['x-request-id'], 'private');
  const metrics = await api.get('/metrics').set('Authorization', `Bearer ${config.metricsToken}`).expect(200);
  assert.match(metrics.text, /route="\/livez"/);
  assert.match(metrics.text, /gpss_http_duration_seconds_bucket/);
  assert.equal(metrics.text.includes('private'), false);
  assert.equal(JSON.stringify(logs).includes('untrusted-path-secret'), false);
  assert.equal(JSON.stringify(logs).includes('private'), false);
  assert.equal(metrics.headers['cache-control'], 'no-store');
});

test('aborted HTTP requests are counted once as 499, even when close repeats', () => {
  const telemetry = createTelemetry();
  const res = Object.assign(new EventEmitter(), { locals: {}, setHeader() {}, statusCode: 200, writableFinished: false });
  telemetry.middleware({ method: 'WEIRD' }, res, () => {});
  res.emit('close'); res.emit('finish');
  assert.match(telemetry.render(), /gpss_http_requests_total\{method="OTHER",route="unmatched",status="499"\} 1/);
});

test('delivery failures use bounded backoff, clear leases and dead-letter after eight attempts', async () => {
  const config = { notificationWebhookUrl: 'https://notify.example.com', notificationWebhookSecret: secret, deliveryEncryptionKey: 'ab'.repeat(32) };
  let attempt = 0;
  let update;
  const job = { id: userId, type: 'leave.applied', createdAt: new Date(), payload: encryptPayload({ userId }, config.deliveryEncryptionKey) };
  const prisma = { $transaction: async (fn) => fn(prisma), deliveryJob: {
    findFirst: async () => job,
    update: async ({ data }) => ({ ...job, ...data, attempts: ++attempt }),
    updateMany: async (args) => { update = args; return { count: 1 }; },
  } };
  const worker = createDeliveryWorker({ prisma, config, fetcher: async () => { throw new Error('private credentials'); } });
  await worker.runOne();
  assert.equal(update.data.lockToken, null);
  assert.equal(update.data.failedAt, undefined);
  assert.match(update.where.lockToken, /^[a-f0-9-]{36}$/);
  attempt = 7;
  await worker.runOne();
  assert.ok(update.data.failedAt);
  assert.deepEqual(update.data.payload, {});
});

test('retention defaults to dry-run and never selects business data or refresh evidence', async () => {
  let deletes = 0;
  const delegate = { findMany: async () => [{ id: userId }], deleteMany: async () => { deletes += 1; return { count: 1 }; } };
  const db = { passwordReset: delegate, notification: delegate, deliveryJob: delegate, $transaction: async (fn) => fn(db) };
  assert.equal((await runRetention(db)).dryRun, true);
  assert.equal(deletes, 0);
  assert.equal((await runRetention(db, { apply: true })).dryRun, false);
  assert.equal(deletes, 3);
  await assert.rejects(runRetention(db, { days: 0 }));
});

test('geofence transitions ignore uncertainty, mock points, historical samples and duplicates', async () => {
  assert.equal(distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 }), 0);
  assert.ok(Math.abs(distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0.01, longitude: 0 }) - 1112) < 2);
  let reads = 0;
  const tx = { geofence: { findMany: async () => { reads += 1; return []; } } };
  const service = createWorkflowService({ prisma: tx, config: { geofencesEnabled: true, locationPingMaxAccuracyMeters: 100 } });
  const session = { id: userId, userId, status: 'punched_in', punchedInAt: new Date('2026-09-05T08:00Z'), lastKnownCapturedAt: new Date('2026-09-05T10:00Z') };
  for (const point of [{ isMock: true, accuracy: 5 }, { accuracy: null }, { accuracy: 101 }, { accuracy: 10, capturedAt: new Date('2026-09-05T09:00Z') }]) {
    await service.evaluateGeofences(tx, session, { capturedAt: new Date('2026-09-05T10:00Z'), ...point });
  }
  assert.equal(reads, 0);
});

test('extension config rejects incomplete delivery, insecure reset URLs and weak metrics credentials', () => {
  for (const changes of [{ METRICS_TOKEN: 'short' }, { NOTIFICATION_WEBHOOK_URL: 'http://example.com' },
    { NOTIFICATION_WEBHOOK_URL: 'https://example.com' }, { PASSWORD_RESET_URL: 'https://example.com/reset' },
    { NOTIFICATION_WEBHOOK_URL: 'https://user:pass@example.com' }]) {
    assert.throws(() => loadConfig({ JWT_SECRET_KEY: secret, ...changes }));
  }
});
