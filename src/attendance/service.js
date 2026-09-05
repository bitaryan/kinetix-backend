import { randomUUID } from 'node:crypto';

import { ApiError, validationError } from '../common/api.js';
import { createImageStorage } from '../upload/image-storage.js';
import {
  decimalToFixed,
  parseOptionalPunchInstant,
  tryParseAwareInstant,
} from './validation.js';

const SETTINGS_KEY = 'default';
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1_000;

function cloneDate(value) {
  return value instanceof Date ? new Date(value.getTime()) : new Date(value);
}

function instant(value) {
  if (value === null || value === undefined) return null;
  return cloneDate(value);
}

function iso(value) {
  return value === null || value === undefined ? null : cloneDate(value).toISOString();
}

function isPrismaCode(error, ...codes) {
  return codes.includes(error?.code);
}

function isStale(capturedAt, now) {
  return Math.abs(capturedAt.getTime() - now.getTime()) > MAX_CLOCK_SKEW_MS;
}

async function serializable(prisma, callback, { retries = 3, retryUnique = false } = {}) {
  let attempt = 0;
  while (true) {
    const afterCommit = [];
    let result;
    try {
      const operation = (tx) => callback(tx, (effect) => afterCommit.push(effect));
      result = typeof prisma.$transaction === 'function'
        ? await prisma.$transaction(operation, { isolationLevel: 'Serializable' })
        : await operation(prisma);
    } catch (error) {
      const retryable = error?.code === 'P2034' || (retryUnique && error?.code === 'P2002');
      if (!retryable || attempt >= retries) throw error;
      attempt += 1;
      continue;
    }
    // Only the committed attempt may publish. A fan-out failure must not turn a
    // committed punch into an HTTP failure or trigger deletion of its images.
    for (const effect of afterCommit) {
      try {
        await effect();
      } catch {
        console.warn('Could not publish committed attendance update');
      }
    }
    return result;
  }
}

function userIdOf(principal) {
  return principal?.user?.id ?? principal?.user?.userId ?? principal?.userId ?? principal?.id;
}

export function toPunchSessionData(session, locationMode) {
  return {
    sessionId: session.id,
    status: session.status,
    punchedInAt: iso(session.punchedInAt),
    punchedOutAt: iso(session.punchedOutAt),
    openingOdoKm: decimalToFixed(session.openingOdoKm),
    closingOdoKm: decimalToFixed(session.closingOdoKm),
    latitude: session.punchInLatitude,
    longitude: session.punchInLongitude,
    locationMode,
  };
}

export function toPunchOutData(session) {
  return {
    sessionId: session.id,
    status: 'punched_out',
    punchedInAt: iso(session.punchedInAt),
    punchedOutAt: iso(session.punchedOutAt),
  };
}

export function createLocationModeCache({ ttlMs = 30_000, clock = () => Date.now() } = {}) {
  let cached;
  let cachedAt = 0;
  return {
    get() {
      if (cached === undefined || clock() - cachedAt > ttlMs) return null;
      return cached;
    },
    set(mode) {
      cached = mode;
      cachedAt = clock();
    },
    clear() {
      cached = undefined;
      cachedAt = 0;
    },
  };
}

export function createAttendanceService({
  prisma,
  config,
  liveHub,
  imageStorage = createImageStorage(config),
  modeCache = createLocationModeCache(),
  now = () => new Date(),
  createId = randomUUID,
}) {
  if (!prisma) throw new TypeError('prisma is required');

  async function resolveLocationMode(db = prisma) {
    const cached = modeCache.get();
    if (cached !== null) return cached;
    const row = await db.locationSettings.findUnique({ where: { singletonKey: SETTINGS_KEY } });
    const mode = row?.locationMode ?? 'continuous';
    modeCache.set(mode);
    return mode;
  }

  async function current(userId) {
    return prisma.attendanceSession.findFirst({
      where: { userId, status: 'punched_in' },
      orderBy: { punchedInAt: 'desc' },
    });
  }

  async function publish(session, userId, db) {
    if (typeof liveHub?.publish !== 'function') return;
    await liveHub.publish(session, userId, db);
  }

  async function punchIn(userId, request) {
    const sessionId = createId();
    const saved = [];
    let selfiePath;
    let openingOdoImagePath;
    try {
      return await serializable(prisma, async (tx, afterCommit) => {
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user) throw new ApiError(401, 'UNAUTHORIZED', 'User account is unavailable');

        const existing = await tx.attendanceSession.findFirst({
          where: { userId, status: 'punched_in' },
          orderBy: { punchedInAt: 'desc' },
        });
        if (existing) {
          throw new ApiError(
            409,
            'ALREADY_PUNCHED_IN',
            'An active punch-in session already exists',
          );
        }

        const locationMode = await resolveLocationMode(tx);
        const serverNow = now();
        const capturedAt = parseOptionalPunchInstant(request.capturedAt, serverNow);
        if (isStale(capturedAt, serverNow)) {
          throw new ApiError(400, 'STALE_TIMESTAMP', 'capturedAt is too far from server time');
        }

        if (!selfiePath) {
          selfiePath = await imageStorage.saveAttendanceImage(
            request.selfie, userId, sessionId, 'selfie',
          );
          saved.push(selfiePath);
        }
        if (!openingOdoImagePath) {
          openingOdoImagePath = await imageStorage.saveAttendanceImage(
            request.openingOdoImage, userId, sessionId, 'opening_odo',
          );
          saved.push(openingOdoImagePath);
        }

        const session = await tx.attendanceSession.create({
          data: {
            id: sessionId,
            userId,
            status: 'punched_in',
            openingOdoKm: request.openingOdoKm,
            openingSelfiePath: selfiePath,
            openingOdoImagePath,
            punchInLatitude: request.latitude,
            punchInLongitude: request.longitude,
            punchInAccuracy: request.accuracy,
            punchedInAt: serverNow,
            pingCount: 1,
            lastKnownLatitude: request.latitude,
            lastKnownLongitude: request.longitude,
            lastKnownAccuracy: request.accuracy,
            lastKnownCapturedAt: capturedAt,
            updatedAt: serverNow,
          },
        });
        await tx.locationPing.create({
          data: {
            attendanceSessionId: sessionId,
            latitude: request.latitude,
            longitude: request.longitude,
            accuracy: request.accuracy,
            capturedAt,
          },
        });
        afterCommit(() => publish(session, userId, prisma));
        return { session, locationMode };
      });
    } catch (error) {
      await imageStorage.deleteStoredFiles(...saved);
      if (isPrismaCode(error, 'P2002')) {
        throw new ApiError(
          409,
          'ALREADY_PUNCHED_IN',
          'An active punch-in session already exists',
        );
      }
      throw error;
    }
  }

  async function findDuplicate(tx, sessionId, clientEventId) {
    if (!clientEventId) return null;
    return tx.locationPing.findFirst({
      where: { attendanceSessionId: sessionId, clientEventId },
    });
  }

  async function evaluatePoint(tx, session, point, locationMode, serverNow) {
    const duplicate = await findDuplicate(tx, session.id, point.clientEventId);
    if (duplicate) {
      return { accepted: true, duplicate: true, reason: 'DUPLICATE', pingId: duplicate.id };
    }

    const capturedAt = tryParseAwareInstant(point.capturedAt);
    const punchedInAt = instant(session.punchedInAt);
    const punchedOutAt = instant(session.punchedOutAt);
    const inClosedWindow = session.status === 'punched_out'
      && punchedOutAt !== null
      && capturedAt !== null
      && capturedAt.getTime() >= punchedInAt.getTime()
      && capturedAt.getTime() <= punchedOutAt.getTime();
    if (session.status !== 'punched_in' && !inClosedWindow) {
      return { accepted: false, reason: 'SESSION_NOT_ACTIVE' };
    }
    if (locationMode === 'single') return { accepted: false, reason: 'SINGLE_LOCATION_MODE' };
    if (session.pingCount >= config.locationPingMaxPerSession) {
      return { accepted: false, reason: 'SESSION_TRAIL_FULL' };
    }
    if (capturedAt === null) return { accepted: false, reason: 'INVALID_TIMESTAMP' };
    if (isStale(capturedAt, serverNow)) return { accepted: false, reason: 'STALE_PING' };
    if (point.accuracy !== null && point.accuracy > config.locationPingMaxAccuracyMeters) {
      return { accepted: false, reason: 'LOW_ACCURACY' };
    }

    const latest = instant(session.lastKnownCapturedAt);
    const intervalMs = config.locationPingMinIntervalSeconds * 1_000;
    if (intervalMs > 0) {
      const gap = latest === null ? null : capturedAt.getTime() - latest.getTime();
      if (gap !== null && Math.abs(gap) < intervalMs) {
        return { accepted: false, reason: 'TOO_FREQUENT' };
      }
      if (gap === null || gap < 0) {
        // Queued samples can arrive behind the latest position, including after
        // punch-out. Only in-shift samples qualify for this backfill exception.
        if (capturedAt.getTime() < punchedInAt.getTime()) {
          return { accepted: false, reason: 'TOO_FREQUENT' };
        }
        // Use the existing (session, captured_at) index to check both temporal
        // neighbors. A newer final ping is not itself a reason to drop a trail.
        const nearby = await tx.locationPing.findFirst({
          where: {
            attendanceSessionId: session.id,
            capturedAt: {
              gt: new Date(capturedAt.getTime() - intervalMs),
              lt: new Date(capturedAt.getTime() + intervalMs),
            },
          },
          select: { id: true },
        });
        if (nearby) return { accepted: false, reason: 'TOO_FREQUENT' };
      }
    }
    return { accepted: true, duplicate: false, capturedAt };
  }

  function latestPositionData(session, point, capturedAt) {
    const latest = instant(session.lastKnownCapturedAt);
    if (latest !== null && capturedAt.getTime() < latest.getTime()) return {};
    return {
      lastKnownLatitude: point.latitude,
      lastKnownLongitude: point.longitude,
      lastKnownAccuracy: point.accuracy,
      lastKnownCapturedAt: capturedAt,
    };
  }

  async function persistAccepted(tx, session, point, capturedAt) {
    const ping = await tx.locationPing.create({
      data: {
        attendanceSessionId: session.id,
        latitude: point.latitude,
        longitude: point.longitude,
        accuracy: point.accuracy,
        capturedAt,
        battery: point.battery,
        speed: point.speed,
        clientEventId: point.clientEventId,
        isMock: point.isMock,
      },
    });
    const updated = await tx.attendanceSession.update({
      where: { id: session.id },
      data: {
        pingCount: { increment: 1 },
        ...latestPositionData(session, point, capturedAt),
        updatedAt: now(),
      },
    });
    return { ping, session: updated };
  }

  async function locationPing(userId, request) {
    const locationMode = await resolveLocationMode();
    return serializable(prisma, async (tx, afterCommit) => {
      let session = await tx.attendanceSession.findUnique({ where: { id: request.sessionId } });
      if (!session || session.userId !== userId) {
        return { accepted: false, reason: 'SESSION_NOT_FOUND', pingId: null, locationMode };
      }
      const outcome = await evaluatePoint(
        tx,
        session,
        request,
        locationMode,
        now(),
      );
      if (!outcome.accepted) {
        return { accepted: false, reason: outcome.reason, pingId: null, locationMode };
      }
      if (outcome.duplicate) {
        return { accepted: true, reason: 'DUPLICATE', pingId: outcome.pingId, locationMode };
      }
      const persisted = await persistAccepted(tx, session, request, outcome.capturedAt);
      session = persisted.session;
      afterCommit(() => publish(session, userId, prisma));
      return { accepted: true, reason: null, pingId: persisted.ping.id, locationMode };
    }, { retryUnique: Boolean(request.clientEventId) });
  }

  function rejectAll(count, reason, locationMode) {
    return {
      acceptedCount: 0,
      rejectedCount: count,
      locationMode,
      items: Array.from({ length: count }, (_, index) => ({
        index,
        accepted: false,
        reason,
        pingId: null,
      })),
    };
  }

  async function locationPingBatch(userId, request) {
    if (request.pings.length > config.locationPingBatchMax) throw validationError();
    const locationMode = await resolveLocationMode();
    return serializable(prisma, async (tx, afterCommit) => {
      let session = await tx.attendanceSession.findUnique({ where: { id: request.sessionId } });
      if (!session || session.userId !== userId) {
        return rejectAll(request.pings.length, 'SESSION_NOT_FOUND', locationMode);
      }
      const serverNow = now();
      const ordered = request.pings
        .map((point, index) => ({ point, index, parsed: tryParseAwareInstant(point.capturedAt) }))
        .sort((left, right) => {
          const leftTime = left.parsed?.getTime() ?? Number.NEGATIVE_INFINITY;
          const rightTime = right.parsed?.getTime() ?? Number.NEGATIVE_INFINITY;
          return leftTime - rightTime || left.index - right.index;
        });
      const byIndex = new Map();
      let published = false;
      for (const item of ordered) {
        const outcome = await evaluatePoint(
          tx,
          session,
          item.point,
          locationMode,
          serverNow,
        );
        if (!outcome.accepted) {
          byIndex.set(item.index, {
            index: item.index,
            accepted: false,
            reason: outcome.reason,
            pingId: null,
          });
          continue;
        }
        if (outcome.duplicate) {
          byIndex.set(item.index, {
            index: item.index,
            accepted: true,
            reason: 'DUPLICATE',
            pingId: outcome.pingId,
          });
          continue;
        }
        const persisted = await persistAccepted(tx, session, item.point, outcome.capturedAt);
        session = persisted.session;
        byIndex.set(item.index, {
          index: item.index,
          accepted: true,
          reason: null,
          pingId: persisted.ping.id,
        });
        published = true;
      }
      if (published) afterCommit(() => publish(session, userId, prisma));

      const items = request.pings.map((_point, index) => byIndex.get(index));
      const acceptedCount = items.filter((item) => item.accepted).length;
      return {
        acceptedCount,
        rejectedCount: items.length - acceptedCount,
        locationMode,
        items,
      };
    }, { retryUnique: request.pings.some((point) => Boolean(point.clientEventId)) });
  }

  async function punchOut(userId, request) {
    // Reuse this operation's image across retries, never another caller's path.
    const savedBySession = new Map();
    let result;
    try {
      result = await serializable(prisma, async (tx, afterCommit) => {
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user) throw new ApiError(401, 'UNAUTHORIZED', 'User account is unavailable');
        let session = await tx.attendanceSession.findFirst({
          where: { userId, status: 'punched_in' },
          orderBy: { punchedInAt: 'desc' },
        });
        if (!session) {
          throw new ApiError(409, 'NOT_PUNCHED_IN', 'No active punch-in session to close');
        }
        if (request.closingOdoKm.lessThan(session.openingOdoKm)) {
          throw new ApiError(
            400,
            'INVALID_ODO_READING',
            'Closing odometer must be greater than or equal to opening odometer',
          );
        }

        const serverNow = now();
        const capturedAt = parseOptionalPunchInstant(request.capturedAt, serverNow);
        if (isStale(capturedAt, serverNow)) {
          throw new ApiError(400, 'STALE_TIMESTAMP', 'capturedAt is too far from server time');
        }

        let closingOdoImagePath = savedBySession.get(session.id);
        if (!closingOdoImagePath) {
          closingOdoImagePath = await imageStorage.saveAttendanceImage(
            request.closingOdoImage, userId, session.id, 'closing_odo',
          );
          savedBySession.set(session.id, closingOdoImagePath);
        }
        const locationMode = await resolveLocationMode(tx);
        const appendFinalPing = locationMode === 'continuous'
          && session.pingCount < config.locationPingMaxPerSession;
        if (appendFinalPing) {
          await tx.locationPing.create({
            data: {
              attendanceSessionId: session.id,
              latitude: request.latitude,
              longitude: request.longitude,
              accuracy: request.accuracy,
              capturedAt,
            },
          });
        }

        session = await tx.attendanceSession.update({
          where: { id: session.id },
          data: {
            status: 'punched_out',
            closingOdoKm: request.closingOdoKm,
            closingOdoImagePath,
            punchOutLatitude: request.latitude,
            punchOutLongitude: request.longitude,
            punchOutAccuracy: request.accuracy,
            punchedOutAt: serverNow,
            ...(appendFinalPing ? {
              pingCount: { increment: 1 },
              ...latestPositionData(session, request, capturedAt),
            } : {}),
            updatedAt: serverNow,
          },
        });
        afterCommit(() => publish(session, userId, prisma));
        return session;
      });
    } catch (error) {
      await imageStorage.deleteStoredFiles(...savedBySession.values());
      throw error;
    }
    await imageStorage.deleteStoredFiles(
      ...[...savedBySession.values()].filter((storedPath) => storedPath !== result.closingOdoImagePath),
    );
    return result;
  }

  async function updateLocationMode(locationMode) {
    const serverNow = now();
    const row = await serializable(prisma, (tx) => tx.locationSettings.upsert({
      where: { singletonKey: SETTINGS_KEY },
      update: { locationMode, updatedAt: serverNow },
      create: {
        id: createId(),
        singletonKey: SETTINGS_KEY,
        locationMode,
        updatedAt: serverNow,
      },
    }));
    modeCache.set(row.locationMode);
    return row.locationMode;
  }

  return Object.freeze({
    current,
    locationPing,
    locationPingBatch,
    modeCache,
    punchIn,
    punchOut,
    resolveLocationMode,
    updateLocationMode,
    userIdOf,
  });
}
