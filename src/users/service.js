import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { hashPassword, userProfile, validateCreateUserRequest } from '../auth/service.js';
import { ApiError, notFound, validationError } from '../common/api.js';
import { containsLiteral, listOptions, readPage, strictBody } from '../common/v2.js';
import { booleanValue, EMAIL_PATTERN, enumValue, stringValue, uuidValue } from '../common/validation.js';
import { serializable } from '../db/transaction.js';
import { audit, enqueueDelivery } from '../workflows/events.js';

const PROFILE_SELECT = { id: true, employeeId: true, employeeName: true, email: true, role: true, isActive: true, locationTrackingEnabled: true, createdAt: true };
const tokenHash = (value) => createHash('sha256').update(value).digest('hex');
const resetMessage = { message: 'If the account is eligible, password reset instructions will be sent' };
function newPassword(value) {
  return validateCreateUserRequest({ userId: 'VALIDATION', employeeName: 'Validation', email: 'validation@example.com', password: value }).password;
}
async function passwordMatches(raw, hash) {
  try { return await argon2.verify(hash, raw); } catch { return false; }
}
function mapConflict(error) {
  if (error?.code !== 'P2002') throw error;
  const employee = String(error.meta?.target).includes('employee');
  throw new ApiError(409, employee ? 'EMPLOYEE_ID_EXISTS' : 'EMAIL_EXISTS',
    employee ? 'An account with this employee ID already exists' : 'An account with this email already exists');
}

export function createUserManagementService({ prisma, config, liveHub }) {
  async function list(query) {
    const options = listOptions(query);
    const role = query.role === undefined ? undefined : enumValue(query.role, ['EMPLOYEE', 'MANAGER', 'ADMIN']);
    const isActive = query.isActive === undefined ? undefined : enumValue(query.isActive, ['true', 'false']) === 'true';
    const where = { role, isActive, ...(options.search ? { OR: ['employeeId', 'employeeName', 'email'].map((key) => ({ [key]: containsLiteral(options.search) })) } : {}) };
    const result = await readPage(prisma, 'user', where, options, { select: PROFILE_SELECT });
    return { ...result, data: result.data.map(userProfile) };
  }
  async function get(id) {
    const user = await prisma.user.findUnique({ where: { id: uuidValue(id) }, select: PROFILE_SELECT });
    if (!user) throw notFound('User not found');
    return userProfile(user);
  }
  async function bulkCreate(actor, input) {
    const body = strictBody(input, ['users']);
    if (!Array.isArray(body.users) || body.users.length < 1 || body.users.length > 25) throw validationError('Provide between 1 and 25 users');
    const users = body.users.map(validateCreateUserRequest);
    if (users.some((user) => user.role === 'ADMIN')) throw new ApiError(403, 'FORBIDDEN', 'Administrator accounts can only be created through the bootstrap script');
    if (new Set(users.map((user) => user.employeeId)).size !== users.length || new Set(users.map((user) => user.email)).size !== users.length) throw validationError('Duplicate users in batch');
    // Bound hashing concurrency and do it before opening the transaction.
    const data = [];
    for (const { password, ...user } of users) data.push({ ...user, passwordHash: await hashPassword(password) });
    try {
      return await serializable(prisma, async (tx) => {
        const created = [];
        for (const user of data) {
          const result = await tx.user.create({ data: user, select: PROFILE_SELECT });
          await audit(tx, actor.id, result.id, 'user.created', result.id, { role: result.role });
          created.push(userProfile(result));
        }
        return created;
      });
    } catch (error) { return mapConflict(error); }
  }
  async function update(actor, id, input, self = false) {
    if (!self && actor.role !== 'ADMIN') throw new ApiError(403, 'FORBIDDEN', 'You do not have permission for this action');
    const body = strictBody(input, self ? ['employeeName', 'email', 'currentPassword'] : ['employeeName', 'email', 'role', 'isActive', 'locationTrackingEnabled']);
    const data = {};
    if (body.employeeName !== undefined) data.employeeName = stringValue(body.employeeName, { min: 1, max: 100 });
    if (body.email !== undefined) {
      data.email = stringValue(body.email, { max: 255 }).toLowerCase();
      if (!EMAIL_PATTERN.test(data.email)) throw validationError();
    }
    if (!self && body.role !== undefined) data.role = enumValue(body.role, ['EMPLOYEE', 'MANAGER']);
    if (!self && body.isActive !== undefined) data.isActive = booleanValue(body.isActive);
    if (!self && body.locationTrackingEnabled !== undefined) data.locationTrackingEnabled = booleanValue(body.locationTrackingEnabled);
    if (!Object.keys(data).length) throw validationError();
    try {
      const result = await serializable(prisma, async (tx) => {
        const user = await tx.user.findUnique({ where: { id: uuidValue(id) } });
        if (!user) throw notFound('User not found');
        if ((data.role !== undefined || data.isActive !== undefined) && (user.role === 'ADMIN' || user.id === actor.id)) {
          throw new ApiError(403, 'FORBIDDEN', 'Administrator and own access cannot be changed through this endpoint');
        }
        if (data.isActive === false && await tx.attendanceSession.findFirst({ where: { userId: id, status: 'punched_in' } })) {
          throw new ApiError(409, 'ACTIVE_ATTENDANCE', 'The user must punch out before deactivation');
        }
        if (self && data.email !== undefined && data.email !== user.email &&
            !await passwordMatches(stringValue(body.currentPassword, { trim: false, min: 8, max: 128 }), user.passwordHash)) {
          throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid user ID or password');
        }
        const trackingChanged = data.locationTrackingEnabled !== undefined && data.locationTrackingEnabled !== user.locationTrackingEnabled;
        if (trackingChanged && await tx.attendanceSession.findFirst({ where: { userId: id, status: 'punched_in' } })) {
          throw new ApiError(409, 'ACTIVE_ATTENDANCE', "Can't change during working shift");
        }
        const changed = await tx.user.update({ where: { id },
          data: { ...data, ...(trackingChanged ? { locationTrackingSince: new Date() } : {}) }, select: PROFILE_SELECT });
        if (trackingChanged) {
          await tx.geofenceState.deleteMany({ where: { session: { userId: id } } });
          await audit(tx, actor.id, id, 'user.location_tracking_updated', id, { enabled: data.locationTrackingEnabled });
        }
        if (data.isActive === false || data.role !== undefined || data.email !== undefined) {
          await tx.activeSession.updateMany({ where: { userId: id, isRevoked: false }, data: { isRevoked: true } });
          await tx.passwordReset.updateMany({ where: { userId: id, usedAt: null }, data: { usedAt: new Date() } });
        }
        await audit(tx, actor.id, id, 'user.updated', id, { fields: Object.keys(data) });
        return { profile: userProfile(changed), trackingChanged };
      });
      if (result.trackingChanged && !result.profile.locationTrackingEnabled) {
        try { await liveHub?.removeUser(id); } catch { console.warn('Could not publish location tracking change'); }
      }
      return result.profile;
    } catch (error) { return mapConflict(error); }
  }
  async function changePassword(actor, input) {
    const body = strictBody(input, ['currentPassword', 'newPassword']);
    const current = stringValue(body.currentPassword, { trim: false, min: 8, max: 128 });
    const hash = await hashPassword(newPassword(body.newPassword));
    await serializable(prisma, async (tx) => {
      const user = await tx.user.findUnique({ where: { id: actor.id } });
      if (!user?.isActive || !await passwordMatches(current, user.passwordHash)) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid user ID or password');
      await tx.user.update({ where: { id: actor.id }, data: { passwordHash: hash, noOfAttempts: 0, lockedUntil: null } });
      await tx.activeSession.updateMany({ where: { userId: actor.id }, data: { isRevoked: true } });
      await tx.passwordReset.updateMany({ where: { userId: actor.id, usedAt: null }, data: { usedAt: new Date() } });
      await audit(tx, actor.id, actor.id, 'user.password_changed', actor.id);
    });
    return { message: 'Password changed; sign in again' };
  }
  async function forgotPassword(input) {
    const body = strictBody(input, ['userId']);
    const employeeId = stringValue(body.userId, { min: 1, max: 30 }).toUpperCase();
    if (!config.passwordResetUrl || !config.notificationWebhookUrl) throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Password recovery is not configured');
    const raw = randomBytes(32).toString('base64url');
    await serializable(prisma, async (tx) => {
      const user = await tx.user.findUnique({ where: { employeeId } });
      if (!user?.isActive) return;
      const now = new Date();
      if (await tx.passwordReset.findFirst({ where: { userId: user.id, createdAt: { gt: new Date(now.getTime() - 60000) } } })) return;
      await tx.passwordReset.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
      const expiresAt = new Date(now.getTime() + 30 * 60000);
      const reset = await tx.passwordReset.create({ data: { userId: user.id, tokenHash: tokenHash(raw), expiresAt } });
      const url = new URL(config.passwordResetUrl);
      url.hash = new URLSearchParams({ token: raw }).toString();
      await enqueueDelivery(tx, config, 'password.reset', { email: user.email, resetUrl: url.toString(), resetId: reset.id, expiresAt: expiresAt.toISOString() });
    });
    return resetMessage;
  }
  async function resetPassword(input) {
    const body = strictBody(input, ['token', 'newPassword']);
    const raw = stringValue(body.token, { min: 43, max: 43 });
    const hash = await hashPassword(newPassword(body.newPassword));
    await serializable(prisma, async (tx) => {
      const reset = await tx.passwordReset.findUnique({ where: { tokenHash: tokenHash(raw) }, include: { user: true } });
      if (!reset || reset.usedAt || reset.expiresAt <= new Date() || !reset.user.isActive) throw new ApiError(400, 'INVALID_RESET_TOKEN', 'Password reset token is invalid or expired');
      await tx.user.update({ where: { id: reset.userId }, data: { passwordHash: hash, noOfAttempts: 0, lockedUntil: null } });
      await tx.passwordReset.updateMany({ where: { userId: reset.userId, usedAt: null }, data: { usedAt: new Date() } });
      await tx.activeSession.updateMany({ where: { userId: reset.userId }, data: { isRevoked: true } });
      await audit(tx, reset.userId, reset.userId, 'user.password_reset', reset.userId);
    });
    return { message: 'Password reset; sign in again' };
  }
  return { list, get, bulkCreate, update, changePassword, forgotPassword, resetPassword };
}
