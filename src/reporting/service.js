import { Prisma } from '@prisma/client';
import { ApiError, notFound } from '../common/api.js';
import { containsLiteral, dateRange, listOptions, readPage, userScope } from '../common/v2.js';
import { enumValue, uuidValue } from '../common/validation.js';

const STAFF = { id: true, employeeId: true, employeeName: true };
const MAX_REPORT_ROWS = 10000;

export function attendanceDto(row) {
  const minutes = row.punchedOutAt === null ? null : Math.max(0, Math.floor((row.punchedOutAt - row.punchedInAt) / 60000));
  return {
    id: row.id, userId: row.userId, employeeId: row.user.employeeId, employeeName: row.user.employeeName,
    autoPunchedOut: row.autoPunchedOut === true, punchOutLabel: row.autoPunchedOut ? 'Auto punch out' : null,
    status: row.status, punchedInAt: row.punchedInAt, punchedOutAt: row.punchedOutAt,
    openingOdoKm: row.openingOdoKm == null ? null : new Prisma.Decimal(row.openingOdoKm).toFixed(2),
    closingOdoKm: row.closingOdoKm === null ? null : new Prisma.Decimal(row.closingOdoKm).toFixed(2),
    distanceKm: row.closingOdoKm == null || row.openingOdoKm == null ? null : new Prisma.Decimal(row.closingOdoKm).minus(row.openingOdoKm).toFixed(2),
    workedMinutes: minutes, pingCount: row.pingCount,
    punchInLocation: { latitude: row.punchInLatitude, longitude: row.punchInLongitude, accuracy: row.punchInAccuracy ?? null },
    punchOutLocation: row.punchOutLatitude == null || row.punchOutLongitude == null ? null : {
      latitude: row.punchOutLatitude, longitude: row.punchOutLongitude, accuracy: row.punchOutAccuracy ?? null,
    },
    selfieUrl: `/uploads/${row.openingSelfiePath}`, openingOdoImageUrl: row.openingOdoImagePath ? `/uploads/${row.openingOdoImagePath}` : null,
    closingOdoImageUrl: row.closingOdoImagePath ? `/uploads/${row.closingOdoImagePath}` : null,
  };
}

export function summarizeAttendance(rows, dailyOvertimeMinutes) {
  const users = new Map();
  for (const row of rows) {
    const user = users.get(row.userId) ?? { userId: row.userId, employeeId: row.user.employeeId,
      employeeName: row.user.employeeName, sessions: 0, openSessions: 0, workedMinutes: 0,
      distance: new Prisma.Decimal(0), hasDistance: false, days: new Map() };
    user.sessions += 1;
    if (!row.punchedOutAt) user.openSessions += 1;
    else {
      // Split completed shifts at UTC midnight before applying the daily rule.
      let start = row.punchedInAt.getTime();
      while (start < row.punchedOutAt.getTime()) {
        const day = new Date(start).toISOString().slice(0, 10);
        const stop = Math.min(new Date(`${day}T00:00:00Z`).getTime() + 86400000, row.punchedOutAt.getTime());
        const minutes = (stop - start) / 60000;
        user.days.set(day, (user.days.get(day) ?? 0) + minutes);
        user.workedMinutes += minutes;
        start = stop;
      }
    }
    if (row.closingOdoKm != null && row.openingOdoKm != null) {
      user.distance = user.distance.plus(new Prisma.Decimal(row.closingOdoKm).minus(row.openingOdoKm));
      user.hasDistance = true;
    }
    users.set(row.userId, user);
  }
  return [...users.values()].map(({ days, distance, hasDistance, ...user }) => ({ ...user,
    workedMinutes: Math.floor(user.workedMinutes), distanceKm: hasDistance ? distance.toFixed(2) : null,
    overtimeMinutes: dailyOvertimeMinutes == null ? null : Math.floor([...days.values()]
      .reduce((sum, minutes) => sum + Math.max(0, minutes - dailyOvertimeMinutes), 0)),
  }));
}

export function createReportingService({ prisma }) {
  function filter(actor, query) {
    const options = listOptions(query);
    const range = dateRange(query);
    const userId = userScope(actor, query.userId);
    const status = query.status === undefined ? undefined : enumValue(query.status, ['punched_in', 'punched_out']);
    const where = { userId, status, punchedInAt: { gte: range.startDate, lt: range.until },
      ...(options.search ? { user: { OR: ['employeeId', 'employeeName'].map((key) => ({ [key]: containsLiteral(options.search) })) } } : {}) };
    return { options, where, range };
  }
  async function list(actor, query) {
    const { where, options } = filter(actor, query);
    const result = await readPage(prisma, 'attendanceSession', where, options,
      { include: { user: { select: STAFF } }, orderBy: [{ punchedInAt: 'desc' }, { id: 'desc' }] });
    return { ...result, data: result.data.map(attendanceDto) };
  }
  async function session(actor, id) {
    const row = await prisma.attendanceSession.findFirst({ where: { id: uuidValue(id),
      ...(actor.role === 'EMPLOYEE' ? { userId: actor.id } : {}) }, include: { user: { select: STAFF } } });
    if (!row) throw notFound('Attendance session not found');
    return row;
  }
  async function detail(actor, id) { return attendanceDto(await session(actor, id)); }
  async function trail(actor, id, query) {
    const row = await session(actor, id);
    const options = listOptions(query);
    return readPage(prisma, 'locationPing', { attendanceSessionId: row.id }, options, {
      orderBy: [{ capturedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, latitude: true, longitude: true, accuracy: true, capturedAt: true,
        speed: true, battery: true, isMock: true, accuracyFlag: true },
    });
  }
  async function report(actor, query) {
    const { where, range } = filter(actor, query);
    return prisma.$transaction(async (tx) => {
      const rows = await tx.attendanceSession.findMany({ where, take: MAX_REPORT_ROWS + 1,
        orderBy: [{ punchedInAt: 'asc' }, { id: 'asc' }], include: { user: { select: STAFF } } });
      if (rows.length > MAX_REPORT_ROWS) throw new ApiError(422, 'REPORT_TOO_LARGE', 'Narrow the date range or select one user');
      const isAdmin = actor.role === 'ADMIN';
      const policy = isAdmin ? await tx.workforcePolicy.findUnique({ where: { key: 'default' } }) : null;
      const summaries = summarizeAttendance(rows, policy?.dailyOvertimeMinutes).map((summary) => {
        if (isAdmin) return summary;
        const { overtimeMinutes, ...visible } = summary;
        return visible;
      });
      return { range: { from: range.startDate.toISOString().slice(0, 10), to: range.endDate.toISOString().slice(0, 10), timezone: 'UTC' },
        ...(isAdmin ? { dailyOvertimeMinutes: policy?.dailyOvertimeMinutes ?? null } : {}),
        summaries, sessions: rows.map(attendanceDto) };
    }, { isolationLevel: 'RepeatableRead' });
  }
  async function dashboard(actor, query) {
    const range = dateRange(query);
    const userId = userScope(actor, query.userId);
    return prisma.$transaction(async (tx) => ({
      activeStaff: await tx.user.count({ where: { id: userId, isActive: true, role: { in: ['EMPLOYEE', 'MANAGER'] } } }),
      punchedIn: await tx.attendanceSession.count({ where: { userId, status: 'punched_in' } }),
      attendanceSessions: await tx.attendanceSession.count({ where: { userId, punchedInAt: { gte: range.startDate, lt: range.until } } }),
      clientVisits: await tx.clientLog.count({ where: { userId, logDate: { gte: range.startDate, lt: range.until } } }),
      pendingLeaves: await tx.leave.count({ where: { userId, status: 'PENDING' } }),
    }), { isolationLevel: 'RepeatableRead' });
  }
  return { list, detail, trail, report, dashboard };
}
