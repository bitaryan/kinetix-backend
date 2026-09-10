import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createClientLogService } from '../../src/clientlog/service.js';
import { createLeaveService } from '../../src/leave/service.js';
import { createUploadService } from '../../src/upload/service.js';
import { createImageStorage } from '../../src/upload/image-storage.js';

const EMPLOYEE_ID = '11111111-1111-4111-8111-111111111111';
const MANAGER_ID = '22222222-2222-4222-8222-222222222222';
const ITEM_ID = '33333333-3333-4333-8333-333333333333';

function transactionClient(tx) {
  return {
    ...tx,
    async $transaction(operation, options) {
      assert.equal(options.isolationLevel, 'Serializable');
      return operation(tx);
    },
  };
}

function apiFailure(status, code, message) {
  return (error) => {
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    return true;
  };
}

test('leave service scopes employee lists and hides another employee’s detail', async () => {
  const calls = [];
  const leave = { id: ITEM_ID, userId: MANAGER_ID };
  const service = createLeaveService({
    prisma: {
      leave: {
        count: async ({ where }) => { calls.push(where); return 1; },
        findMany: async (args) => { calls.push(args); return [leave]; },
        findUnique: async () => leave,
      },
    },
  });
  const employee = { id: EMPLOYEE_ID, role: 'EMPLOYEE' };
  const manager = { id: MANAGER_ID, role: 'MANAGER' };
  assert.deepEqual(await service.list(employee, { page: 2, limit: 10, status: 'APPROVED' }), {
    total: 1, leaves: [leave],
  });
  assert.deepEqual(calls[0], { userId: EMPLOYEE_ID, status: 'APPROVED' });
  assert.equal(calls[1].skip, 10);
  assert.equal(calls[1].take, 10);
  await service.list(manager, { page: 1, limit: 20 });
  assert.deepEqual(calls[2], {});
  await assert.rejects(service.get(employee, ITEM_ID), apiFailure(404, 'NOT_FOUND', 'Leave application not found'));
  assert.equal(await service.get(manager, ITEM_ID), leave);
});

test('leave service enforces date ranges, active users, and inclusive pending/approved overlap', async () => {
  const input = {
    startDate: new Date('2026-09-04T00:00:00Z'),
    endDate: new Date('2026-09-05T00:00:00Z'),
    reason: 'Holiday',
  };
  let active = false;
  let overlapArgs;
  const service = createLeaveService({
    prisma: transactionClient({
      user: { findUnique: async () => ({ id: EMPLOYEE_ID, isActive: active }) },
      leave: {
        findFirst: async (args) => { overlapArgs = args; return { id: ITEM_ID }; },
        create: async () => assert.fail('Invalid applications must not create leave rows'),
      },
    }),
  });
  await assert.rejects(service.apply(EMPLOYEE_ID, { ...input, endDate: new Date('2026-09-03') }),
    apiFailure(422, 'INVALID_DATE_RANGE', 'End date cannot be earlier than start date.'));
  await assert.rejects(service.apply(EMPLOYEE_ID, input),
    apiFailure(401, 'UNAUTHORIZED', 'User account is unavailable'));
  assert.equal(overlapArgs, undefined);
  active = true;
  await assert.rejects(service.apply(EMPLOYEE_ID, input),
    apiFailure(409, 'LEAVE_OVERLAP', 'A leave application already exists for overlapping dates'));
  assert.deepEqual(overlapArgs.where, {
    userId: EMPLOYEE_ID,
    status: { in: ['PENDING', 'APPROVED'] },
    startDate: { lte: input.endDate },
    endDate: { gte: input.startDate },
  });
});

test('leave status service rejects invalid reasons, self decisions, and non-pending leave', async () => {
  let existing = { id: ITEM_ID, userId: MANAGER_ID, status: 'PENDING' };
  let updated;
  const service = createLeaveService({
    prisma: transactionClient({
      leave: {
        findUnique: async () => existing,
        update: async (args) => { updated = args; return { ...existing, ...args.data }; },
      },
    }),
  });
  const actor = { id: MANAGER_ID, role: 'ADMIN' };
  await assert.rejects(service.updateStatus({ ...actor, role: 'MANAGER' }, ITEM_ID, { status: 'APPROVED' }),
    apiFailure(403, 'FORBIDDEN', 'You do not have permission for this action'));
  for (const input of [
    { status: 'REJECTED', rejectionReason: null },
    { status: 'APPROVED', rejectionReason: 'Not allowed' },
  ]) {
    await assert.rejects(service.updateStatus(actor, ITEM_ID, input),
      apiFailure(422, 'VALIDATION_ERROR', 'Request data is invalid'));
  }
  const approved = { status: 'APPROVED', rejectionReason: null };
  await assert.rejects(service.updateStatus(actor, ITEM_ID, approved),
    apiFailure(403, 'FORBIDDEN', 'You cannot approve or reject your own leave application'));
  existing = { ...existing, userId: EMPLOYEE_ID, status: 'CANCELLED' };
  await assert.rejects(service.updateStatus(actor, ITEM_ID, approved),
    apiFailure(409, 'INVALID_LEAVE_STATE', 'Only pending leave applications can be updated'));
  assert.equal(updated, undefined);
  existing = { ...existing, status: 'PENDING' };
  const result = await service.updateStatus(actor, ITEM_ID, { status: 'REJECTED', rejectionReason: 'Staffing' });
  assert.equal(result.status, 'REJECTED');
  assert.equal(updated.data.approvedBy, MANAGER_ID);
  assert.equal(updated.data.rejectionReason, 'Staffing');
  assert.ok(updated.data.updatedAt instanceof Date);
});

test('client-log service validates paired coordinates and cleans a saved image after failed persistence', async () => {
  const input = {
    clientName: 'Client', companyName: 'Company', mobileNumber: '9876543210',
    mailId: 'client@example.com', logDate: new Date('2026-09-04'),
    latitude: null, longitude: null, locationAccuracy: null,
  };
  const stored = `client_logs/2026/09/${EMPLOYEE_ID}/${ITEM_ID}.jpg`;
  const calls = [];
  const databaseFailure = new Error('Persistence failed');
  const service = createClientLogService({
    prisma: { clientLog: { create: async () => { throw databaseFailure; } } },
    images: {
      saveClientLogSelfie: async () => { calls.push('save'); return stored; },
      deleteStoredFiles: async (file) => calls.push(file),
    },
  });
  await assert.rejects(service.create(EMPLOYEE_ID, { ...input, latitude: 27 }, { originalname: 'selfie.jpg' }),
    apiFailure(422, 'VALIDATION_ERROR', 'latitude and longitude must be provided together'));
  assert.deepEqual(calls, []);
  await assert.rejects(service.create(EMPLOYEE_ID, input, { originalname: 'selfie.jpg' }),
    (error) => error === databaseFailure);
  assert.deepEqual(calls, ['save', stored]);
});

test('client-log delete denies managers and never deletes images without a deleted row', async () => {
  let findWhere;
  let deleteWhere;
  let count = 0;
  const deleted = [];
  const service = createClientLogService({
    prisma: {
      clientLog: {
        findFirst: async ({ where }) => { findWhere = where; return { selfiePath: 'selfie.jpg' }; },
        deleteMany: async ({ where }) => { deleteWhere = where; return { count }; },
      },
    },
    images: { deleteStoredFiles: async (file) => deleted.push(file) },
  });
  await assert.rejects(service.remove({ id: MANAGER_ID, role: 'MANAGER' }, ITEM_ID),
    apiFailure(403, 'FORBIDDEN', 'You do not have permission for this action'));
  assert.equal(findWhere, undefined);
  assert.equal(deleteWhere, undefined);
  await assert.rejects(service.remove({ id: MANAGER_ID, role: 'ADMIN' }, ITEM_ID),
    apiFailure(404, 'NOT_FOUND', 'Client log not found'));
  assert.deepEqual(findWhere, { id: ITEM_ID });
  assert.deepEqual(deleteWhere, findWhere);
  assert.deepEqual(deleted, []);
  count = 1;
  await service.remove({ id: MANAGER_ID, role: 'ADMIN' }, ITEM_ID);
  assert.deepEqual(findWhere, { id: ITEM_ID });
  assert.deepEqual(deleteWhere, findWhere);
  assert.deepEqual(deleted, ['selfie.jpg']);
});

test('upload service uses real-path ownership for client logs and symlinks within the upload root', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'gpss-business-service-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'uploads');
  const ownDirectory = path.join(root, 'client_logs', '2026', '09', EMPLOYEE_ID);
  const otherDirectory = path.join(root, 'attendance', MANAGER_ID, ITEM_ID);
  await mkdir(ownDirectory, { recursive: true });
  await mkdir(otherDirectory, { recursive: true });
  const ownImage = path.join(ownDirectory, 'selfie.jpg');
  const otherImage = path.join(otherDirectory, 'selfie.jpg');
  await writeFile(ownImage, Buffer.from([0xff, 0xd8, 0xff]));
  await writeFile(otherImage, Buffer.from([0xff, 0xd8, 0xff]));
  await symlink(otherImage, path.join(ownDirectory, 'linked.jpg'));
  const service = createUploadService({ config: { uploadDir: root } });
  const employee = { id: EMPLOYEE_ID, role: 'EMPLOYEE' };
  const missing = apiFailure(404, 'NOT_FOUND', 'File not found');
  const resolved = await service.resolveFile(employee, path.relative(root, ownImage));
  assert.equal(resolved.size, 3);
  assert.equal(path.basename(resolved.absolutePath), 'selfie.jpg');
  await assert.rejects(service.resolveFile(employee, path.relative(root, otherImage)), missing);
  await assert.rejects(service.resolveFile(employee, path.relative(root, path.join(ownDirectory, 'linked.jpg'))), missing);
  for (const unsafe of ['', '../outside.jpg', 'invalid\0.jpg', path.relative(root, ownDirectory)]) {
    await assert.rejects(service.resolveFile(employee, unsafe), missing);
  }
  const manager = { id: MANAGER_ID, role: 'MANAGER' };
  assert.equal((await service.resolveFile(manager, path.relative(root, ownImage))).size, 3);
});

test('image storage rejects valid magic bytes that disagree with the declared content type', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'gpss-image-format-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const images = createImageStorage({ uploadDir: temporary, maxUploadBytes: 1024 });
  const png = { buffer: Buffer.from('89504e470d0a1a0a', 'hex'), mimetype: 'image/jpeg' };
  const jpeg = { buffer: Buffer.from('ffd8ff', 'hex'), mimetype: 'image/png' };
  for (const file of [png, jpeg]) {
    await assert.rejects(images.saveAttendanceImage(file, EMPLOYEE_ID, ITEM_ID, 'selfie'), {
      status: 400, code: 'INVALID_IMAGE',
    });
    await assert.rejects(images.saveClientLogSelfie(file, EMPLOYEE_ID, ITEM_ID), {
      status: 400, code: 'INVALID_IMAGE', message: 'Image size exceeds 5MB or invalid format',
    });
  }
  const stored = await images.saveClientLogSelfie({ ...jpeg, mimetype: 'image/jpg' }, EMPLOYEE_ID, ITEM_ID);
  assert.match(stored, /\.jpg$/);
});
