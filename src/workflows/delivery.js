import { createHmac, randomUUID } from 'node:crypto';
import { serializable } from '../db/transaction.js';
import { decryptPayload } from './events.js';

export function createDeliveryWorker({ prisma, config, fetcher = fetch, now = () => new Date() }) {
  async function runOne() {
    if (!config.notificationWebhookUrl) return false;
    const lockToken = randomUUID();
    const claimed = await serializable(prisma, async (tx) => {
      const job = await tx.deliveryJob.findFirst({ where: { deliveredAt: null, failedAt: null,
        availableAt: { lte: now() }, OR: [{ lockedUntil: null }, { lockedUntil: { lte: now() } }] },
      orderBy: [{ availableAt: 'asc' }, { id: 'asc' }] });
      if (!job) return null;
      if (job.attempts >= 8) {
        await tx.deliveryJob.update({ where: { id: job.id }, data: { failedAt: now(), payload: {}, lockedUntil: null, lockToken: null } });
        return { exhausted: true };
      }
      return tx.deliveryJob.update({ where: { id: job.id }, data: {
        lockToken, lockedUntil: new Date(now().getTime() + 60000), attempts: { increment: 1 },
      } });
    }, { retries: 4 });
    if (!claimed) return false;
    if (claimed.exhausted) return true;
    const where = { id: claimed.id, lockToken };
    let expired = false;
    try {
      const payload = decryptPayload(claimed.payload, config.deliveryEncryptionKey);
      if (claimed.type === 'password.reset') {
        const reset = await prisma.passwordReset.findUnique({ where: { id: payload.resetId } });
        expired = !reset || Boolean(reset.usedAt) || reset.expiresAt <= now();
        if (expired) throw new Error('Reset expired');
      }
      const timestamp = String(Math.floor(now().getTime() / 1000));
      const body = JSON.stringify({ id: claimed.id, type: claimed.type, payload, createdAt: claimed.createdAt });
      const signature = createHmac('sha256', config.notificationWebhookSecret).update(`${timestamp}.${body}`).digest('hex');
      const response = await fetcher(config.notificationWebhookUrl, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': claimed.id,
          'X-GPSS-Timestamp': timestamp, 'X-GPSS-Signature': signature }, body,
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error('Delivery failed');
      await prisma.deliveryJob.updateMany({ where, data: {
        deliveredAt: now(), lockedUntil: null, lockToken: null, payload: {},
      } });
    } catch {
      const failed = expired || claimed.attempts >= 8;
      await prisma.deliveryJob.updateMany({ where, data: {
        lockedUntil: null, lockToken: null,
        availableAt: new Date(now().getTime() + Math.min(3600000, 30000 * 2 ** (claimed.attempts - 1))),
        ...(failed ? { failedAt: now(), payload: {} } : {}),
      } });
    }
    return true;
  }
  return { runOne };
}
