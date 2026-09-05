import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PrismaClient } from '@prisma/client';

import { requireTestDatabaseUrl } from './database.js';

if (!process.env.TEST_DATABASE_URL) {
  test('PostgreSQL constraint verification requires TEST_DATABASE_URL', { skip: true }, () => {});
} else {
  const databaseUrl = requireTestDatabaseUrl();
  test('migrations enforce native enum values, partial unique indexes and leave date constraint', async (t) => {
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const userId = randomUUID();
    const settingsId = randomUUID();
    t.after(async () => {
      try {
        await prisma.locationSettings.deleteMany({ where: { id: settingsId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      } finally {
        await prisma.$disconnect();
      }
    });
    await prisma.user.create({
      data: {
        id: userId,
        employeeId: `TEST${userId.replaceAll('-', '').slice(0, 20)}`,
        employeeName: 'Schema verification fixture',
        email: `${userId}@schema-test.example.com`,
        passwordHash: 'not-a-login-password',
        role: 'EMPLOYEE',
      },
    });
    for (const role of ['ADMIN', 'MANAGER', 'EMPLOYEE']) {
      assert.equal((await prisma.user.update({ where: { id: userId }, data: { role } })).role, role);
    }

    await prisma.locationSettings.create({
      data: { id: settingsId, singletonKey: `test-${settingsId.slice(0, 16)}`, locationMode: 'continuous' },
    });
    assert.equal((await prisma.locationSettings.update({
      where: { id: settingsId }, data: { locationMode: 'single' },
    })).locationMode, 'single');

    const sessionData = {
      userId,
      status: 'punched_in',
      openingOdoKm: '0.00',
      openingSelfiePath: 'test/unused.jpg',
      openingOdoImagePath: 'test/unused-odo.jpg',
      punchInLatitude: 0,
      punchInLongitude: 0,
      punchedInAt: new Date(),
    };
    const firstSession = await prisma.attendanceSession.create({ data: sessionData });
    await assert.rejects(prisma.attendanceSession.create({ data: sessionData }), { code: 'P2002' });
    await prisma.attendanceSession.update({ where: { id: firstSession.id }, data: { status: 'punched_out' } });
    const activeSession = await prisma.attendanceSession.create({ data: sessionData });
    await prisma.attendanceSession.create({ data: { ...sessionData, status: 'punched_out' } });
    assert.equal(await prisma.attendanceSession.count({ where: { userId, status: 'punched_in' } }), 1);

    const pingData = {
      attendanceSessionId: activeSession.id,
      latitude: 1,
      longitude: 2,
      capturedAt: new Date(),
      clientEventId: randomUUID(),
    };
    await prisma.locationPing.create({ data: pingData });
    await assert.rejects(prisma.locationPing.create({ data: pingData }), { code: 'P2002' });
    // The same event is valid in a different session; null IDs remain unlimited.
    await prisma.locationPing.create({ data: { ...pingData, attendanceSessionId: firstSession.id } });
    await prisma.locationPing.createMany({ data: [
      { ...pingData, clientEventId: null },
      { ...pingData, clientEventId: null },
    ] });
    assert.equal(await prisma.locationPing.count({ where: { attendanceSessionId: activeSession.id } }), 3);

    const leaveData = {
      userId,
      startDate: new Date('2026-09-10T00:00:00.000Z'),
      endDate: new Date('2026-09-10T00:00:00.000Z'),
      reason: 'Schema verification',
    };
    for (const status of ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']) {
      assert.equal((await prisma.leave.create({ data: { ...leaveData, status } })).status, status);
    }
    await assert.rejects(prisma.leave.create({
      data: { ...leaveData, endDate: new Date('2026-09-09T00:00:00.000Z') },
    }), (error) => {
      assert.match(String(error.message), /chk_leaves_date_range/);
      return true;
    });
  });
}
