function value(record, camel, snake) {
  return record?.[camel] ?? record?.[snake] ?? null;
}

function iso(valueToFormat) {
  if (valueToFormat === null || valueToFormat === undefined) return null;
  return new Date(valueToFormat).toISOString();
}

export function livePresence(capturedAt, now, config) {
  const ageSeconds = Math.floor((now.getTime() - new Date(capturedAt).getTime()) / 1_000);
  if (ageSeconds > config.liveOfflineAfterSeconds) return 'offline';
  if (ageSeconds > config.liveStaleAfterSeconds) return 'stale';
  return 'live';
}

export function toLiveLocationData(session, user, config, now = new Date()) {
  const capturedAt = value(session, 'lastKnownCapturedAt', 'last_known_captured_at');
  return {
    sessionId: value(session, 'id', 'session_id'),
    userId: value(user, 'id', 'user_id'),
    employeeId: value(user, 'employeeId', 'employee_id'),
    employeeName: value(user, 'employeeName', 'employee_name'),
    latitude: value(session, 'lastKnownLatitude', 'last_known_latitude'),
    longitude: value(session, 'lastKnownLongitude', 'last_known_longitude'),
    accuracy: value(session, 'lastKnownAccuracy', 'last_known_accuracy'),
    capturedAt: iso(capturedAt),
    presence: livePresence(capturedAt, now, config),
    status: value(session, 'status', 'status'),
  };
}

export function createLiveLocationHub({ prisma, config, redis, now = () => new Date() }) {
  const listeners = new Set();
  function emit(data) {
    for (const listener of [...listeners]) {
      try { listener(data); } catch { console.warn('Live-location subscriber failed'); }
    }
  }
  const unsubscribe = redis?.subscribe(emit);

  async function snapshot() {
    const sessions = await prisma.attendanceSession.findMany({
      where: {
        status: 'punched_in',
        lastKnownCapturedAt: { not: null },
      },
      include: { user: { select: { id: true, employeeId: true, employeeName: true } } },
    });
    const result = [];
    const serverNow = now();
    for (const session of sessions) {
      const user = session.user;
      if (user) result.push(toLiveLocationData(session, user, config, serverNow));
    }
    return result;
  }

  async function publish(session, userId, db = prisma) {
    const capturedAt = value(session, 'lastKnownCapturedAt', 'last_known_captured_at');
    if (capturedAt === null) return null;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, employeeId: true, employeeName: true },
    });
    if (!user) return null;
    const data = toLiveLocationData(session, user, config, now());
    emit(data);
    if (redis) await redis.publish(data);
    return data;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return Object.freeze({ publish, snapshot, subscribe, close() { unsubscribe?.(); listeners.clear(); } });
}
