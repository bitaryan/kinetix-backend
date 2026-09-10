import { serializable } from '../db/transaction.js';

// Explicitly selected operational data only. Attendance, GPS, leave, uploads,
// audit events and refresh-reuse evidence remain under business retention policy.
export async function runRetention(prisma, { days = 30, apply = false, batchSize = 500, now = new Date() } = {}) {
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650 || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error('Invalid retention limits');
  }
  const cutoff = new Date(now.getTime() - days * 86400000);
  const models = {
    passwordReset: { expiresAt: { lt: cutoff } },
    notification: { readAt: { lt: cutoff } },
    deliveryJob: { OR: [{ deliveredAt: { lt: cutoff } }, { failedAt: { lt: cutoff } }] },
  };
  return serializable(prisma, async (tx) => {
    const results = {};
    for (const [model, where] of Object.entries(models)) {
      const rows = await tx[model].findMany({ where, select: { id: true }, take: batchSize, orderBy: { id: 'asc' } });
      results[model] = apply && rows.length ? (await tx[model].deleteMany({
        where: { AND: [where, { id: { in: rows.map((row) => row.id) } }] },
      })).count : rows.length;
    }
    return { dryRun: !apply, cutoff, batchSize, counts: results };
  });
}
