import { ApiError, notFound, validationError } from '../common/api.js';
import { dateRange, isoDate, listOptions, readPage, strictBody, userScope } from '../common/v2.js';
import { booleanValue, enumValue, numberValue, stringValue, uuidValue } from '../common/validation.js';
import { serializable } from '../db/transaction.js';
import { audit, createWorkflowEvents, notify } from './events.js';

const yearValue = (value) => numberValue(value, { min: 2000, max: 2099, integer: true });
const leaveDto = (row) => ({ ...row, startDate: row.startDate.toISOString().slice(0, 10), endDate: row.endDate.toISOString().slice(0, 10) });
const holidayDto = (row) => ({ ...row, date: row.date.toISOString().slice(0, 10) });
export function countedLeaveDays(start, end, year, weekendDays = [], holidays = []) {
  const holidaySet = new Set(holidays.map((day) => day.toISOString().slice(0, 10)));
  const lower = Math.max(start.getTime(), Date.UTC(year, 0, 1));
  const upper = Math.min(end.getTime(), Date.UTC(year, 11, 31));
  let days = 0;
  for (let time = lower; time <= upper; time += 86400000) {
    const date = new Date(time);
    if (!weekendDays.includes(date.getUTCDay()) && !holidaySet.has(date.toISOString().slice(0, 10))) days += 1;
  }
  return days;
}

export function distanceMeters(a, b) {
  const rad = (value) => value * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function createWorkflowService({ prisma, config }) {
  const leaveEvent = createWorkflowEvents(config);
  async function listLeaves(actor, query) {
    const userId = userScope(actor, query.userId);
    const status = query.status === undefined ? undefined : enumValue(query.status, ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);
    const result = await readPage(prisma, 'leave', { userId, status }, listOptions(query));
    return { ...result, data: result.data.map(leaveDto) };
  }
  async function cancel(actor, id, input) {
    const body = strictBody(input ?? {}, ['reason']);
    const reason = stringValue(body.reason ?? '', { max: 500 });
    id = uuidValue(id);
    return serializable(prisma, async (tx) => {
      const leave = await tx.leave.findUnique({ where: { id } });
      if (!leave || leave.userId !== actor.id) throw notFound('Leave application not found');
      if (leave.status === 'CANCELLED') return leave;
      if (leave.status !== 'PENDING' && !(leave.status === 'APPROVED' && leave.startDate > new Date())) {
        throw new ApiError(409, 'INVALID_LEAVE_STATE', 'Only pending or future approved leave can be cancelled');
      }
      const updated = await tx.leave.update({ where: { id }, data: { status: 'CANCELLED' } });
      await leaveEvent(tx, actor.id, updated, leave.status);
      await audit(tx, actor.id, actor.id, 'leave.cancelled', id, { reason });
      return updated;
    }).then(leaveDto);
  }
  async function history(actor, id, query) {
    id = uuidValue(id);
    const leave = await prisma.leave.findFirst({ where: { id, ...(actor.role === 'EMPLOYEE' ? { userId: actor.id } : {}) }, select: { id: true } });
    if (!leave) throw notFound('Leave application not found');
    return readPage(prisma, 'auditEvent', { resourceId: id, action: { startsWith: 'leave.' } }, listOptions(query));
  }
  async function policy(actor) {
    const result = await prisma.workforcePolicy.findUnique({ where: { key: 'default' } }) ??
      { key: 'default', weekendDays: [], dailyOvertimeMinutes: null, updatedAt: null };
    if (actor.role === 'ADMIN') return result;
    const { dailyOvertimeMinutes, ...visible } = result;
    return visible;
  }
  async function updatePolicy(actor, input) {
    const body = strictBody(input, ['weekendDays', 'dailyOvertimeMinutes']);
    if (!Array.isArray(body.weekendDays) || body.weekendDays.length > 6 || new Set(body.weekendDays).size !== body.weekendDays.length) throw validationError();
    const data = { weekendDays: body.weekendDays.map((value) => numberValue(value, { min: 0, max: 6, integer: true })),
      dailyOvertimeMinutes: body.dailyOvertimeMinutes === null ? null : numberValue(body.dailyOvertimeMinutes, { min: 1, max: 1440, integer: true }) };
    if (new Set(data.weekendDays).size !== data.weekendDays.length) throw validationError();
    return serializable(prisma, async (tx) => {
      const row = await tx.workforcePolicy.upsert({ where: { key: 'default' }, create: { key: 'default', ...data }, update: data });
      await audit(tx, actor.id, null, 'policy.updated', actor.id, data);
      return row;
    });
  }
  async function balance(actor, query) {
    const userId = userScope(actor, query.userId) ?? actor.id;
    const year = yearValue(query.year ?? new Date().getUTCFullYear());
    return prisma.$transaction(async (tx) => {
      if (!await tx.user.findUnique({ where: { id: userId }, select: { id: true } })) throw notFound('User not found');
      const from = new Date(Date.UTC(year, 0, 1));
      const to = new Date(Date.UTC(year, 11, 31));
      const entitlement = await tx.leaveEntitlement.findUnique({ where: { userId_year: { userId, year } } });
      const rule = await tx.workforcePolicy.findUnique({ where: { key: 'default' } });
      const holidays = await tx.holiday.findMany({ where: { date: { gte: from, lte: to } } });
      const leaves = await tx.leave.findMany({ where: { userId, status: { in: ['PENDING', 'APPROVED'] }, startDate: { lte: to }, endDate: { gte: from } } });
      let pendingDays = 0;
      let approvedDays = 0;
      for (const leave of leaves) {
        const days = countedLeaveDays(leave.startDate, leave.endDate, year, rule?.weekendDays ?? [], holidays.map((holiday) => holiday.date));
        if (leave.status === 'APPROVED') approvedDays += days; else pendingDays += days;
      }
      return { userId, year, entitlementDays: entitlement?.days ?? null, approvedDays, pendingDays,
        remainingDays: entitlement ? entitlement.days - approvedDays : null,
        availableDays: entitlement ? entitlement.days - approvedDays - pendingDays : null,
        weekendDays: rule?.weekendDays ?? [], timezone: 'UTC', informational: true };
    }, { isolationLevel: 'RepeatableRead' });
  }
  async function entitlement(actor, userId, input) {
    userId = uuidValue(userId);
    const body = strictBody(input, ['year', 'days']);
    const year = yearValue(body.year);
    const days = numberValue(body.days, { min: 0, max: 366, integer: true });
    return serializable(prisma, async (tx) => {
      if (!await tx.user.findUnique({ where: { id: userId }, select: { id: true } })) throw notFound('User not found');
      const row = await tx.leaveEntitlement.upsert({ where: { userId_year: { userId, year } }, create: { userId, year, days }, update: { days } });
      await audit(tx, actor.id, userId, 'leave.entitlement_updated', row.id, { year, days });
      return row;
    });
  }
  async function holidays(query) {
    const year = yearValue(query.year ?? new Date().getUTCFullYear());
    return prisma.holiday.findMany({ where: { date: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } }, orderBy: { date: 'asc' } }).then((rows) => rows.map(holidayDto));
  }
  async function putHoliday(actor, input) {
    const body = strictBody(input, ['date', 'name']);
    const date = isoDate(body.date);
    yearValue(date.getUTCFullYear());
    const name = stringValue(body.name, { min: 1, max: 150 });
    return serializable(prisma, async (tx) => {
      const row = await tx.holiday.upsert({ where: { date }, create: { date, name }, update: { name } });
      await audit(tx, actor.id, null, 'holiday.updated', row.id, { date: body.date, name });
      return row;
    }).then(holidayDto);
  }
  async function deleteHoliday(actor, id) {
    id = uuidValue(id);
    return serializable(prisma, async (tx) => {
      if (!(await tx.holiday.deleteMany({ where: { id } })).count) throw notFound('Holiday not found');
      await audit(tx, actor.id, null, 'holiday.deleted', id);
      return { message: 'Holiday deleted' };
    });
  }
  async function notifications(actor, query) {
    const unread = query.unread === undefined ? false : enumValue(query.unread, ['true', 'false']) === 'true';
    return readPage(prisma, 'notification', { userId: actor.id, ...(unread ? { readAt: null } : {}) }, listOptions(query));
  }
  async function readNotification(actor, id) {
    id = uuidValue(id);
    return serializable(prisma, async (tx) => {
      const row = await tx.notification.findFirst({ where: { id, userId: actor.id } });
      if (!row) throw notFound('Notification not found');
      if (row.readAt) return row;
      return tx.notification.update({ where: { id }, data: { readAt: new Date() } });
    });
  }
  async function auditEvents(query) {
    const range = dateRange(query);
    return readPage(prisma, 'auditEvent', {
      createdAt: { gte: range.startDate, lt: range.until },
      ...(query.resourceId === undefined ? {} : { resourceId: uuidValue(query.resourceId) }),
      ...(query.action === undefined ? {} : { action: stringValue(query.action, { max: 80 }) }),
    }, listOptions(query));
  }
  async function geofences(query) {
    return readPage(prisma, 'geofence', {}, listOptions(query));
  }
  async function saveGeofence(actor, id, input) {
    const body = strictBody(input, ['name', 'latitude', 'longitude', 'radiusMeters', 'isActive']);
    const data = { name: stringValue(body.name, { min: 1, max: 150 }), latitude: numberValue(body.latitude, { min: -90, max: 90 }),
      longitude: numberValue(body.longitude, { min: -180, max: 180 }), radiusMeters: numberValue(body.radiusMeters, { min: 25, max: 100000 }),
      isActive: body.isActive === undefined ? true : booleanValue(body.isActive) };
    if (id) id = uuidValue(id);
    return serializable(prisma, async (tx) => {
      if (id && !await tx.geofence.findUnique({ where: { id } })) throw notFound('Geofence not found');
      if (!id && await tx.geofence.count() >= 100) throw new ApiError(409, 'GEOFENCE_LIMIT', 'At most 100 geofences are supported');
      const row = id ? await tx.geofence.update({ where: { id }, data }) : await tx.geofence.create({ data });
      if (id) await tx.geofenceState.deleteMany({ where: { geofenceId: id } });
      await audit(tx, actor.id, null, id ? 'geofence.updated' : 'geofence.created', row.id, data);
      return row;
    });
  }
  async function evaluateGeofences(tx, session, point) {
    if (!config.geofencesEnabled || session.status !== 'punched_in' || point.isMock === true ||
        point.accuracy == null || point.accuracy > config.locationPingMaxAccuracyMeters ||
        point.capturedAt < session.punchedInAt || point.capturedAt < session.lastKnownCapturedAt) return;
    const fences = await tx.geofence.findMany({ where: { isActive: true }, take: 100 });
    for (const fence of fences) {
      const distance = distanceMeters(fence, point);
      const uncertainty = point.accuracy;
      if (Math.abs(distance - fence.radiusMeters) <= uncertainty) continue;
      const inside = distance < fence.radiusMeters;
      const where = { geofenceId_sessionId: { geofenceId: fence.id, sessionId: session.id } };
      const previous = await tx.geofenceState.findUnique({ where });
      if (previous && point.capturedAt <= previous.capturedAt) continue;
      await tx.geofenceState.upsert({ where, create: { geofenceId: fence.id, sessionId: session.id, inside, capturedAt: point.capturedAt },
        update: { inside, capturedAt: point.capturedAt } });
      // Initial observations establish state; only confident transitions alert.
      if (previous && previous.inside !== inside) {
        const type = inside ? 'geofence.entered' : 'geofence.exited';
        const payload = { geofenceId: fence.id, sessionId: session.id, userId: session.userId, capturedAt: point.capturedAt.toISOString() };
        await audit(tx, null, session.userId, type, fence.id, payload);
        const managers = await tx.user.findMany({ where: { role: { in: ['ADMIN', 'MANAGER'] }, isActive: true }, select: { id: true } });
        for (const manager of managers) await notify(tx, config, manager.id, type, payload);
      }
    }
  }
  return { listLeaves, cancel, history, policy, updatePolicy, balance, entitlement, holidays, putHoliday, deleteHoliday,
    notifications, readNotification, auditEvents, geofences, saveGeofence, evaluateGeofences };
}
