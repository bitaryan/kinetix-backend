import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function encryptPayload(payload, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') };
}

export function decryptPayload(payload, key) {
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(payload.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8'));
}

export async function audit(tx, actorId, subjectId, action, resourceId, details = {}) {
  return tx.auditEvent.create({ data: { actorId, subjectId, action, resourceId, details } });
}

export async function enqueueDelivery(tx, config, type, payload) {
  if (!config.notificationWebhookUrl) return;
  await tx.deliveryJob.create({ data: { type, payload: encryptPayload(payload, config.deliveryEncryptionKey) } });
}

export async function notify(tx, config, userId, type, payload) {
  const notification = await tx.notification.create({ data: { userId, type, payload } });
  await enqueueDelivery(tx, config, type, { notificationId: notification.id, userId, ...payload });
  return notification;
}

export function createWorkflowEvents(config) {
  return async (tx, actorId, leave, previousStatus = null) => {
    await audit(tx, actorId, leave.userId, previousStatus ? 'leave.status_changed' : 'leave.applied', leave.id,
      { previousStatus, status: leave.status });
    if (!previousStatus) {
      const supervisors = await tx.user.findMany({ where: { isActive: true, role: 'ADMIN', id: { not: actorId } }, select: { id: true } });
      for (const user of supervisors) await notify(tx, config, user.id, 'leave.applied', { leaveId: leave.id });
    } else {
      await notify(tx, config, leave.userId, 'leave.status_changed', { leaveId: leave.id, status: leave.status });
    }
  };
}
