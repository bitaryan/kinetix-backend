import { serializable } from '../db/transaction.js';
import { attendanceDay, autoPunchOutAt } from './day.js';

export function createAutoPunchOut({ prisma, liveHub, now = () => new Date() }) {
  return async function autoPunchOut(userId) {
    const serverNow = now();
    const day = attendanceDay(serverNow);
    const where = { userId, status: 'punched_in', punchedInAt: serverNow >= day.cutoff
      ? { lte: serverNow } : { lt: day.start } };
    let count = 0;
    let cursor;
    while (true) {
      const rows = await prisma.attendanceSession.findMany({ where, select: { id: true },
        orderBy: { id: 'asc' }, take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      for (const row of rows) {
        const closed = await serializable(prisma, async (tx) => {
          const session = await tx.attendanceSession.findUnique({ where: { id: row.id } });
          if (!session || session.status !== 'punched_in') return null;
          const punchedOutAt = autoPunchOutAt(session.punchedInAt);
          if (punchedOutAt > serverNow) return null;
          return tx.attendanceSession.update({ where: { id: session.id }, data: {
            status: 'punched_out', punchedOutAt, autoPunchedOut: true,
            closingOdoKm: null, closingOdoImagePath: null,
            punchOutLatitude: null, punchOutLongitude: null, punchOutAccuracy: null,
            updatedAt: serverNow,
          } });
        });
        if (closed) {
          count += 1;
          try { await liveHub?.publish(closed, closed.userId, prisma); }
          catch { console.warn('Could not publish automatic punch-out'); }
        }
      }
      if (rows.length < 100) return count;
      cursor = rows.at(-1).id;
    }
  };
}

// Each replica can run this job: serializable transactions protect manual
// punch-out and other replicas. Startup and periodic sweeps recover downtime.
export function startAutoPunchOutScheduler({ run, now = () => new Date(),
  schedule = setTimeout, cancel = clearTimeout, onError = () => console.error('Automatic punch-out sweep failed') }) {
  let stopped = false;
  let timer;
  let pending;
  function next() {
    if (stopped) return;
    const at = now();
    const untilCutoff = attendanceDay(at).cutoff - at;
    timer = schedule(tick, untilCutoff > 0 ? Math.min(30_000, untilCutoff) : 30_000);
    timer.unref?.();
  }
  function tick() {
    pending = Promise.resolve().then(run).catch(onError).finally(next);
  }
  next();
  return { async stop() { stopped = true; cancel(timer); await pending; } };
}
