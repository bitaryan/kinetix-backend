import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Prisma } from '@prisma/client';

import {
  createAttendanceService,
  toPunchSessionData,
} from '../../src/attendance/service.js';
import { parseOptionalPunchInstant, tryParseAwareInstant } from '../../src/attendance/validation.js';
import { createImageStorage } from '../../src/upload/image-storage.js';

const BASE_TIME = new Date('2026-08-25T10:00:30.000Z');

function config(overrides = {}) {
  return {
    uploadDir: 'uploads/test',
    maxUploadBytes: 5 * 1024 * 1024,
    locationPingMinIntervalSeconds: 5,
    locationPingMaxPerSession: 6000,
    locationPingBatchMax: 120,
    locationPingMaxAccuracyMeters: 100,
    ...overrides,
  };
}

function fakePrisma(initialSession, initialPings = [], { failedCommits = 0 } = {}) {
  const committed = {
    session: { ...initialSession },
    pings: initialPings.map((ping) => ({ ...ping })),
  };
  let revision = 0;
  let attempts = 0;
  function modelsFor(state) {
    return {
    locationSettings: {
      async findUnique() {
        return { singletonKey: 'default', locationMode: 'continuous' };
      },
      async upsert({ update }) {
        return { singletonKey: 'default', locationMode: update.locationMode };
      },
    },
    attendanceSession: {
      async findUnique({ where }) {
        return state.session?.id === where.id ? { ...state.session } : null;
      },
      async findFirst({ where }) {
        return state.session?.userId === where.userId && state.session.status === where.status
          ? { ...state.session } : null;
      },
      async create({ data }) {
        state.session = { ...data };
        return { ...state.session };
      },
      async update({ where, data }) {
        assert.equal(where.id, state.session.id);
        const next = { ...data };
        if (typeof data.pingCount === 'object') next.pingCount = state.session.pingCount + data.pingCount.increment;
        state.session = { ...state.session, ...next };
        return { ...state.session };
      },
    },
    locationPing: {
      async findFirst({ where }) {
        return state.pings.find((ping) => (
          ping.attendanceSessionId === where.attendanceSessionId
          && (where.clientEventId === undefined || ping.clientEventId === where.clientEventId)
          && (where.capturedAt === undefined || (
            new Date(ping.capturedAt) > where.capturedAt.gt
            && new Date(ping.capturedAt) < where.capturedAt.lt
          ))
        )) ?? null;
      },
      async create({ data }) {
        const ping = { id: randomUUID(), ...data };
        state.pings.push(ping);
        return { ...ping };
      },
    },
    user: {
      async findUnique() {
        return { id: initialSession.userId, employeeId: 'EMP1001', employeeName: 'Employee' };
      },
    },
    };
  }
  return {
    ...modelsFor(committed),
    get pings() {
      return committed.pings;
    },
    get session() {
      return committed.session;
    },
    get attempts() {
      return attempts;
    },
    async $transaction(operation, options) {
      assert.equal(options.isolationLevel, 'Serializable');
      attempts += 1;
      const startingRevision = revision;
      const pending = {
        session: { ...committed.session },
        pings: committed.pings.map((ping) => ({ ...ping })),
      };
      const result = await operation(modelsFor(pending));
      if (failedCommits-- > 0 || revision !== startingRevision) {
        throw Object.assign(new Error('Serialization conflict at commit'), { code: 'P2034' });
      }
      committed.session = pending.session;
      committed.pings = pending.pings;
      revision += 1;
      return result;
    },
  };
}

function point(overrides = {}) {
  return {
    latitude: 28.61,
    longitude: 77.21,
    accuracy: 10,
    capturedAt: '2026-08-25T10:00:10.000Z',
    battery: null,
    speed: null,
    clientEventId: null,
    isMock: null,
    ...overrides,
  };
}

test('attendance DTO keeps odometers as two-decimal JSON strings', () => {
  const data = toPunchSessionData({
    id: randomUUID(),
    status: 'punched_in',
    punchedInAt: BASE_TIME,
    punchedOutAt: null,
    openingOdoKm: new Prisma.Decimal('12.5'),
    closingOdoKm: null,
    punchInLatitude: 28.6,
    punchInLongitude: 77.2,
  }, 'continuous');
  assert.equal(data.openingOdoKm, '12.50');
  assert.equal(data.closingOdoKm, null);
  assert.equal(data.status, 'punched_in');
});

test('batch ingestion sorts for evaluation, restores indexes, and counts duplicates as accepted', async () => {
  const userId = randomUUID();
  const sessionId = randomUUID();
  const duplicateEvent = randomUUID();
  const prisma = fakePrisma({
    id: sessionId,
    userId,
    status: 'punched_in',
    punchedInAt: new Date('2026-08-25T09:00:00Z'),
    punchedOutAt: null,
    pingCount: 1,
    lastKnownCapturedAt: new Date('2026-08-25T10:00:00Z'),
  }, [{
    id: randomUUID(),
    attendanceSessionId: sessionId,
    clientEventId: duplicateEvent,
  }]);
  const published = [];
  const service = createAttendanceService({
    prisma,
    config: config(),
    liveHub: { async publish(session) { published.push(session); } },
    imageStorage: {},
    now: () => new Date(BASE_TIME),
  });

  const result = await service.locationPingBatch(userId, {
    sessionId,
    pings: [
      point({ capturedAt: '2026-08-25T10:00:20Z' }),
      point({ capturedAt: '2026-08-25T10:00:10Z' }),
      point({ capturedAt: 'not-a-time', clientEventId: duplicateEvent }),
      point({ capturedAt: '2026-08-25T10:00:25Z', accuracy: 101 }),
    ],
  });

  assert.equal(result.acceptedCount, 3);
  assert.equal(result.rejectedCount, 1);
  assert.deepEqual(result.items.map((item) => item.index), [0, 1, 2, 3]);
  assert.equal(result.items[2].reason, 'DUPLICATE');
  assert.equal(result.items[3].reason, 'LOW_ACCURACY');
  assert.equal(prisma.session.pingCount, 3);
  assert.equal(prisma.session.lastKnownCapturedAt.toISOString(), '2026-08-25T10:00:20.000Z');
  assert.equal(published.length, 1);
});

test('closed sessions accept in-window offline points and reject points after punch-out', async () => {
  const userId = randomUUID();
  const sessionId = randomUUID();
  const prisma = fakePrisma({
    id: sessionId,
    userId,
    status: 'punched_out',
    punchedInAt: new Date('2026-08-25T09:00:00Z'),
    punchedOutAt: new Date('2026-08-25T10:00:00Z'),
    pingCount: 2,
    lastKnownCapturedAt: new Date('2026-08-25T10:00:00Z'),
  });
  const service = createAttendanceService({
    prisma,
    config: config(),
    liveHub: { async publish() {} },
    imageStorage: {},
    now: () => new Date(BASE_TIME),
  });

  const accepted = await service.locationPing(userId, {
    sessionId,
    ...point({ capturedAt: '2026-08-25T09:59:00Z' }),
  });
  assert.equal(accepted.accepted, true);
  assert.equal(prisma.session.pingCount, 3);
  assert.equal(prisma.session.lastKnownCapturedAt.toISOString(), '2026-08-25T10:00:00.000Z');

  const rejected = await service.locationPing(userId, {
    sessionId,
    ...point({ capturedAt: '2026-08-25T10:00:01Z' }),
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'SESSION_NOT_ACTIVE');
});

for (const status of ['punched_in', 'punched_out']) {
  test(`${status} queues respect both timestamp neighbors and keep the newest dashboard position`, async () => {
    const initial = {
      ...activeSession(),
      status,
      punchedOutAt: status === 'punched_out' ? new Date('2026-08-25T10:00:00Z') : null,
      pingCount: 3,
      lastKnownLatitude: 29,
      lastKnownLongitude: 78,
      lastKnownAccuracy: 7,
    };
    const prisma = fakePrisma(initial, [
      '2026-08-25T09:00:00Z', '2026-08-25T09:59:00Z', '2026-08-25T10:00:00Z',
    ].map((capturedAt) => ({
      id: randomUUID(), attendanceSessionId: initial.id, capturedAt: new Date(capturedAt),
    })));
    const publications = [];
    const service = createAttendanceService({
      prisma, config: config(), imageStorage: {}, now: () => new Date(BASE_TIME),
      liveHub: { async publish(session) { publications.push(session); } },
    });
    const result = await service.locationPingBatch(initial.userId, {
      sessionId: initial.id,
      pings: [
        point({ capturedAt: '2026-08-25T09:59:55Z' }), // exactly 5s before final
        point({ capturedAt: '2026-08-25T09:59:03Z' }), // 3s after prior
        point({ capturedAt: '2026-08-25T09:58:57Z' }), // 3s before prior
        point({ capturedAt: '2026-08-25T09:59:05Z' }), // exactly 5s after prior
        point({ capturedAt: '2026-08-25T09:59:08Z' }), // 3s after this batch's insert
        point({ capturedAt: '2026-08-25T09:59:10Z' }),
      ],
    });
    assert.equal(result.acceptedCount, 3);
    assert.equal(result.rejectedCount, 3);
    assert.deepEqual(result.items.map(({ index, accepted, reason }) => ({ index, accepted, reason })), [
      { index: 0, accepted: true, reason: null },
      { index: 1, accepted: false, reason: 'TOO_FREQUENT' },
      { index: 2, accepted: false, reason: 'TOO_FREQUENT' },
      { index: 3, accepted: true, reason: null },
      { index: 4, accepted: false, reason: 'TOO_FREQUENT' },
      { index: 5, accepted: true, reason: null },
    ]);
    assert.equal(prisma.session.pingCount, 6);
    assert.equal(prisma.pings.length, 6);
    for (const session of [prisma.session, ...publications]) {
      for (const field of ['lastKnownLatitude', 'lastKnownLongitude', 'lastKnownAccuracy']) {
        assert.equal(session[field], initial[field]);
      }
      assert.equal(session.lastKnownCapturedAt.getTime(), initial.lastKnownCapturedAt.getTime());
    }
    assert.equal(publications.length, 1);
  });
}

test('backfill preserves shift bounds, quality, freshness, capacity, and ownership checks', async () => {
  const initial = {
    ...activeSession(), status: 'punched_out', punchedOutAt: new Date('2026-08-25T10:00:00Z'),
  };
  const cases = [
    { changes: { capturedAt: '2026-08-25T08:59:59Z' }, reason: 'SESSION_NOT_ACTIVE' },
    { changes: { capturedAt: '2026-08-25T10:00:01Z' }, reason: 'SESSION_NOT_ACTIVE' },
    { changes: { accuracy: 101 }, reason: 'LOW_ACCURACY' },
    { settings: { locationPingMaxPerSession: 1 }, reason: 'SESSION_TRAIL_FULL' },
    { serverNow: new Date('2026-08-26T10:00:30Z'), reason: 'STALE_PING' },
    { userId: randomUUID(), reason: 'SESSION_NOT_FOUND' },
  ];
  for (const { changes, reason, settings, serverNow, userId } of cases) {
    const prisma = fakePrisma(initial);
    const service = createAttendanceService({
      prisma, config: config(settings), imageStorage: {}, now: () => serverNow ?? new Date(BASE_TIME),
    });
    const result = await service.locationPing(userId ?? initial.userId, {
      sessionId: initial.id, ...point({ capturedAt: '2026-08-25T09:59:00Z', ...changes }),
    });
    assert.deepEqual(result, { accepted: false, reason, pingId: null, locationMode: 'continuous' });
    assert.equal(prisma.pings.length, 0);
  }
});

for (const batch of [false, true]) {
  test(`${batch ? 'batch' : 'single'} duplicates remain accepted after switching to single mode`, async () => {
    const initial = activeSession();
    const existing = {
      id: randomUUID(), attendanceSessionId: initial.id, clientEventId: randomUUID(),
      capturedAt: new Date('2026-08-25T09:59:00Z'),
    };
    const prisma = fakePrisma(initial, [existing]);
    const service = createAttendanceService({
      prisma, config: config(), imageStorage: {}, now: () => new Date(BASE_TIME),
    });
    service.modeCache.set('single');
    const duplicate = point({ clientEventId: existing.clientEventId, capturedAt: 'not-a-time' });
    if (batch) {
      const result = await service.locationPingBatch(initial.userId, {
        sessionId: initial.id, pings: [point(), duplicate, duplicate],
      });
      assert.equal(result.acceptedCount, 2);
      assert.equal(result.rejectedCount, 1);
      assert.deepEqual(result.items.map((item) => item.reason), [
        'SINGLE_LOCATION_MODE', 'DUPLICATE', 'DUPLICATE',
      ]);
      assert.equal(result.items[1].pingId, existing.id);
      assert.equal(result.items[2].pingId, existing.id);
    } else {
      assert.deepEqual(await service.locationPing(initial.userId, { sessionId: initial.id, ...duplicate }), {
        accepted: true, reason: 'DUPLICATE', pingId: existing.id, locationMode: 'single',
      });
    }
    assert.equal(prisma.pings.length, 1);
    assert.equal(prisma.session.pingCount, 1);
  });
}

test('concurrent historical samples cannot bypass the minimum interval', async () => {
  const initial = activeSession();
  const prisma = fakePrisma(initial);
  const service = createAttendanceService({
    prisma, config: config(), imageStorage: {}, now: () => new Date(BASE_TIME),
  });
  const result = await Promise.all([0, 1].map(() => service.locationPing(initial.userId, {
    sessionId: initial.id, ...point({ capturedAt: '2026-08-25T09:59:00Z', clientEventId: randomUUID() }),
  })));
  assert.equal(result.filter((item) => item.accepted).length, 1);
  assert.equal(result.find((item) => !item.accepted).reason, 'TOO_FREQUENT');
  assert.equal(prisma.pings.length, 1);
  assert.equal(prisma.session.pingCount, 2);
  assert.equal(prisma.attempts, 3);
});

test('concurrent retries of a historical event insert once and return the same ping ID', async () => {
  const initial = activeSession();
  const prisma = fakePrisma(initial);
  const service = createAttendanceService({
    prisma, config: config(), imageStorage: {}, now: () => new Date(BASE_TIME),
  });
  const request = {
    sessionId: initial.id, ...point({ capturedAt: '2026-08-25T09:59:00Z', clientEventId: randomUUID() }),
  };
  const results = await Promise.all([service.locationPing(initial.userId, request), service.locationPing(initial.userId, request)]);
  assert.ok(results.every((item) => item.accepted));
  assert.equal(results.filter((item) => item.reason === 'DUPLICATE').length, 1);
  assert.equal(results[0].pingId, results[1].pingId);
  assert.equal(prisma.pings.length, 1);
  assert.equal(prisma.session.pingCount, 2);
});

test('disabling the trail interval still preserves the newest last-known position', async () => {
  const initial = { ...activeSession(), lastKnownLatitude: 29, lastKnownLongitude: 78, lastKnownAccuracy: 8 };
  const prisma = fakePrisma(initial);
  const service = createAttendanceService({
    prisma, config: config({ locationPingMinIntervalSeconds: 0 }), imageStorage: {},
    now: () => new Date(BASE_TIME),
  });
  const result = await service.locationPing(initial.userId, {
    sessionId: initial.id, ...point({ capturedAt: '2026-08-25T09:59:59Z' }),
  });
  assert.equal(result.accepted, true);
  assert.equal(prisma.session.lastKnownLatitude, 29);
  assert.equal(prisma.session.lastKnownLongitude, 78);
  assert.equal(prisma.session.lastKnownAccuracy, 8);
  assert.equal(prisma.session.lastKnownCapturedAt.getTime(), initial.lastKnownCapturedAt.getTime());
});

function activeSession() {
  return {
    id: randomUUID(),
    userId: randomUUID(),
    status: 'punched_in',
    openingOdoKm: new Prisma.Decimal('100'),
    punchedInAt: new Date('2026-08-25T09:00:00Z'),
    punchedOutAt: null,
    pingCount: 1,
    lastKnownCapturedAt: new Date('2026-08-25T10:00:00Z'),
  };
}

function jpeg(marker = 1) {
  const buffer = Buffer.from([0xff, 0xd8, 0xff, marker]);
  return { buffer, size: buffer.length, mimetype: 'image/jpeg' };
}

function punchOutRequest(marker = 1) {
  return { ...point(), closingOdoKm: new Prisma.Decimal('110'), closingOdoImage: jpeg(marker) };
}

async function storageFixture(t) {
  const uploadDir = await mkdtemp(path.join(os.tmpdir(), 'gpss-attendance-test-'));
  t.after(() => rm(uploadDir, { recursive: true, force: true }));
  const settings = config({ uploadDir });
  return { uploadDir, settings, imageStorage: createImageStorage(settings) };
}

for (const batch of [false, true]) {
  test(`${batch ? 'batch' : 'single'} GPS publishes only the committed retry`, async () => {
    const initial = activeSession();
    const prisma = fakePrisma(initial, [], { failedCommits: 1 });
    const published = [];
    const service = createAttendanceService({
      prisma,
      config: config(),
      imageStorage: {},
      now: () => new Date(BASE_TIME),
      liveHub: {
        async publish(session, userId, db) {
          assert.equal(db, prisma, 'a closed transaction client must not reach the hub');
          assert.equal(userId, initial.userId);
          assert.equal(prisma.session.pingCount, session.pingCount);
          assert.equal(prisma.pings.length, 1);
          published.push(session);
        },
      },
    });
    const result = batch
      ? await service.locationPingBatch(initial.userId, { sessionId: initial.id, pings: [point()] })
      : await service.locationPing(initial.userId, { sessionId: initial.id, ...point() });
    assert.equal(batch ? result.acceptedCount : result.accepted, batch ? 1 : true);
    assert.equal(prisma.attempts, 2);
    assert.equal(published.length, 1);
  });
}

test('exhausted serialization retries never publish rolled-back points', async () => {
  const initial = activeSession();
  const prisma = fakePrisma(initial, [], { failedCommits: 10 });
  const published = [];
  const service = createAttendanceService({
    prisma,
    config: config(),
    imageStorage: {},
    now: () => new Date(BASE_TIME),
    liveHub: { async publish(session) { published.push(session); } },
  });
  await assert.rejects(service.locationPing(initial.userId, { sessionId: initial.id, ...point() }), { code: 'P2034' });
  assert.equal(prisma.attempts, 4);
  assert.equal(prisma.session.pingCount, 1);
  assert.equal(prisma.pings.length, 0);
  assert.equal(published.length, 0);
});

test('punch-in saves each owned image once across commit retries', async (t) => {
  const { uploadDir, settings, imageStorage } = await storageFixture(t);
  const initial = { ...activeSession(), status: 'punched_out' };
  const prisma = fakePrisma(initial, [], { failedCommits: 1 });
  let saves = 0;
  let publications = 0;
  const service = createAttendanceService({
    prisma, config: settings, now: () => new Date(BASE_TIME),
    imageStorage: {
      ...imageStorage,
      async saveAttendanceImage(...args) { saves += 1; return imageStorage.saveAttendanceImage(...args); },
    },
    liveHub: {
      async publish(session) {
        assert.equal(prisma.session.id, session.id);
        assert.equal(prisma.pings.length, 1);
        publications += 1;
      },
    },
  });
  const { session } = await service.punchIn(initial.userId, {
    ...point(), openingOdoKm: new Prisma.Decimal('100'), selfie: jpeg(1), openingOdoImage: jpeg(2),
  });
  assert.equal(prisma.attempts, 2);
  assert.equal(saves, 2);
  assert.equal(publications, 1);
  assert.deepEqual(await readFile(path.join(uploadDir, session.openingSelfiePath)), jpeg(1).buffer);
  assert.deepEqual(await readFile(path.join(uploadDir, session.openingOdoImagePath)), jpeg(2).buffer);
});

test('concurrent punch-out loser cannot overwrite or delete the committed image', async (t) => {
  const { uploadDir, settings, imageStorage } = await storageFixture(t);
  const initial = activeSession();
  const prisma = fakePrisma(initial);
  let publications = 0;
  const service = createAttendanceService({
    prisma, config: settings, imageStorage, now: () => new Date(BASE_TIME),
    liveHub: {
      async publish(session) {
        assert.equal(prisma.session.status, 'punched_out');
        assert.equal(prisma.session.closingOdoImagePath, session.closingOdoImagePath);
        publications += 1;
      },
    },
  });
  const results = await Promise.allSettled([
    service.punchOut(initial.userId, punchOutRequest(1)),
    service.punchOut(initial.userId, punchOutRequest(2)),
  ]);
  const winner = results.findIndex((result) => result.status === 'fulfilled');
  assert.notEqual(winner, -1);
  assert.equal(results[1 - winner].status, 'rejected');
  assert.equal(results[1 - winner].reason.code, 'NOT_PUNCHED_IN');
  const storedPath = results[winner].value.closingOdoImagePath;
  assert.deepEqual(await readFile(path.join(uploadDir, storedPath)), jpeg(winner + 1).buffer);
  assert.equal((await readdir(path.dirname(path.join(uploadDir, storedPath)))).length, 1);
  assert.equal(publications, 1);
});

test('punch-out retry reuses its image and publication failures preserve committed files', async (t) => {
  const { uploadDir, settings, imageStorage } = await storageFixture(t);
  const initial = activeSession();
  const prisma = fakePrisma(initial, [], { failedCommits: 1 });
  let saves = 0;
  let publications = 0;
  t.mock.method(console, 'warn', () => {});
  const service = createAttendanceService({
    prisma, config: settings, now: () => new Date(BASE_TIME),
    imageStorage: {
      ...imageStorage,
      async saveAttendanceImage(...args) { saves += 1; return imageStorage.saveAttendanceImage(...args); },
    },
    liveHub: { async publish() { publications += 1; throw new Error('Disconnected subscriber'); } },
  });
  const session = await service.punchOut(initial.userId, punchOutRequest());
  assert.equal(prisma.attempts, 2);
  assert.equal(saves, 1);
  assert.equal(publications, 1);
  assert.equal(session.status, 'punched_out');
  assert.deepEqual(await readFile(path.join(uploadDir, session.closingOdoImagePath)), jpeg().buffer);
  assert.equal((await readdir(path.dirname(path.join(uploadDir, session.closingOdoImagePath)))).length, 1);
});

test('punch-out stores its final sample without moving a newer last-known position backwards', async (t) => {
  const { settings, imageStorage } = await storageFixture(t);
  const initial = { ...activeSession(), lastKnownLatitude: 29, lastKnownLongitude: 78, lastKnownAccuracy: 8 };
  const prisma = fakePrisma(initial);
  const service = createAttendanceService({
    prisma, config: settings, imageStorage, now: () => new Date(BASE_TIME),
  });
  const result = await service.punchOut(initial.userId, {
    ...punchOutRequest(), capturedAt: '2026-08-25T09:59:59Z',
  });
  assert.equal(result.status, 'punched_out');
  assert.equal(result.pingCount, 2);
  assert.equal(result.punchOutLatitude, 28.61);
  assert.equal(result.lastKnownLatitude, 29);
  assert.equal(result.lastKnownLongitude, 78);
  assert.equal(result.lastKnownAccuracy, 8);
  assert.equal(result.lastKnownCapturedAt.getTime(), initial.lastKnownCapturedAt.getTime());
  assert.equal(prisma.pings[0].capturedAt.toISOString(), '2026-08-25T09:59:59.000Z');
});

test('aware timestamps reject non-ISO and invalid calendar input with the original punch error', () => {
  for (const raw of [
    '2026-09-04Z', '09/04/2026 10:00:00Z', '2026-02-30T10:00:00Z',
    '2026-09-04 10:00:00Z', '2026-09-04T10:00:00', '2026-09-04T10:00Z',
    '2026-09-04T10:00:00+18:00:01', '2026-09-04T10:00:00+05:60',
    '2026-09-04T24:00:00+00:00', '2026-09-04T23:59:60+00:00',
    '2026-09-04T10:00:00.1234567890Z', '2026-13-01T10:00:00Z',
  ]) {
    assert.equal(tryParseAwareInstant(raw), null, raw);
    assert.throws(() => parseOptionalPunchInstant(raw, BASE_TIME), {
      status: 422, code: 'VALIDATION_ERROR', message: 'capturedAt must include a timezone offset',
    });
  }
});

test('aware timestamps retain Java ISO offset and Instant parser behavior', () => {
  const cases = new Map([
    ['2024-02-29T10:00:00.123456789Z', '2024-02-29T10:00:00.123Z'],
    ['2026-09-04T10:00:00+05:30:15', '2026-09-04T04:29:45.000Z'],
    ['2026-09-04T10:00:00+05', '2026-09-04T05:00:00.000Z'],
    ['2026-09-04T10:00+05:30', '2026-09-04T04:30:00.000Z'],
    ['2026-09-04t10:00:00z', '2026-09-04T10:00:00.000Z'],
    ['2026-09-04T10:00:00.Z', '2026-09-04T10:00:00.000Z'],
    ['2026-09-04T24:00:00Z', '2026-09-05T00:00:00.000Z'],
    ['2026-09-04T23:59:60Z', '2026-09-04T23:59:59.000Z'],
  ]);
  for (const [raw, expected] of cases) {
    assert.equal(tryParseAwareInstant(raw)?.toISOString(), expected, raw);
  }
  assert.equal(parseOptionalPunchInstant(' ', BASE_TIME).toISOString(), BASE_TIME.toISOString());
});

test('image writes reject symlink escapes without changing outside files', async (t) => {
  const { uploadDir, imageStorage } = await storageFixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'gpss-outside-test-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const userId = randomUUID();
  const sessionId = randomUUID();
  await mkdir(path.join(uploadDir, 'attendance'), { recursive: true });
  await symlink(outside, path.join(uploadDir, 'attendance', userId), 'dir');
  await assert.rejects(imageStorage.saveAttendanceImage(jpeg(), userId, sessionId, 'selfie'), { code: 'INTERNAL_ERROR' });
  assert.deepEqual(await readdir(outside), [], 'no directories may be created through an escaped ancestor');

  const otherUser = randomUUID();
  const insideDirectory = path.join(uploadDir, 'attendance', otherUser, sessionId);
  await mkdir(insideDirectory, { recursive: true });
  const outsideFile = path.join(outside, 'original.jpg');
  await writeFile(outsideFile, 'unchanged');
  await symlink(outsideFile, path.join(insideDirectory, 'selfie.jpg'));
  await assert.rejects(imageStorage.saveAttendanceImage(jpeg(), otherUser, sessionId, 'selfie'), { code: 'INTERNAL_ERROR' });
  assert.equal(await readFile(outsideFile, 'utf8'), 'unchanged');
});
