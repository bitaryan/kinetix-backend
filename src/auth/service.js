import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';

import { ApiError, validationError } from '../common/api.js';
import { booleanValue, EMAIL_PATTERN } from '../common/validation.js';
import { serializable } from '../db/transaction.js';

const USER_ROLES = ['ADMIN', 'MANAGER', 'EMPLOYEE'];
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export const ARGON2_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  version: 0x13,
  memoryCost: 1 << 14,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
});

function invalidCredentials() {
  return new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid user ID or password');
}

function invalidRefreshToken() {
  return new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired');
}

function duplicateEmployeeId() {
  return new ApiError(409, 'EMPLOYEE_ID_EXISTS', 'An account with this employee ID already exists');
}

function duplicateEmail() {
  return new ApiError(409, 'EMAIL_EXISTS', 'An account with this email already exists');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredRawString(value, { min = 0, max = Infinity } = {}) {
  if (typeof value !== 'string'
      || value.trim().length === 0
      || value.length < min
      || value.length > max) {
    throw validationError();
  }
  return value;
}

export function validateLoginRequest(input) {
  if (!isPlainObject(input)) throw validationError();
  const rawUserId = requiredRawString(input.userId, { max: 30 });
  const password = requiredRawString(input.password, { min: 8, max: 128 });
  if (typeof input.role !== 'string' || !USER_ROLES.includes(input.role)) throw validationError();
  return {
    employeeId: rawUserId.trim().toUpperCase(),
    password,
    role: input.role,
  };
}

function passwordComplexEnough(password) {
  return /\p{Ll}/u.test(password) && /\p{Lu}/u.test(password) && /\p{Nd}/u.test(password);
}

export function validateCreateUserRequest(input) {
  if (!isPlainObject(input)) throw validationError();
  const rawUserId = requiredRawString(input.userId, { max: 30 });
  const rawName = requiredRawString(input.employeeName, { max: 100 });
  const rawEmail = requiredRawString(input.email, { max: 255 });
  const password = requiredRawString(input.password, { min: 12, max: 128 });
  const role = input.role === undefined || input.role === null ? 'EMPLOYEE' : input.role;

  // Bean Validation runs before Java normalizes the address, so whitespace in
  // the submitted email remains invalid even though stored emails are trimmed.
  if (!EMAIL_PATTERN.test(rawEmail) || typeof role !== 'string' || !USER_ROLES.includes(role)) {
    throw validationError();
  }
  if (!passwordComplexEnough(password)) throw validationError();

  const employeeId = rawUserId.trim().toUpperCase();
  // Uppercasing can expand Unicode characters beyond the database column size.
  if (employeeId.length > 30) throw validationError();

  return {
    employeeId,
    employeeName: rawName.trim(),
    email: rawEmail.trim().toLowerCase(),
    password,
    role,
    locationTrackingEnabled: input.locationTrackingEnabled === undefined ? false : booleanValue(input.locationTrackingEnabled),
  };
}

export function userProfile(user) {
  return {
    id: user.id,
    userId: user.employeeId,
    employeeName: user.employeeName,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    locationTrackingEnabled: user.locationTrackingEnabled === true,
    createdAt: user.createdAt,
  };
}

function uniqueTarget(error) {
  const target = error?.meta?.target;
  return (Array.isArray(target) ? target.join(',') : String(target ?? '')).toLowerCase();
}

function dateValue(value) {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

async function verifyPassword(raw, hash) {
  try {
    return await argon2.verify(hash, raw);
  } catch {
    return false;
  }
}

export async function hashPassword(raw) {
  return argon2.hash(raw, { ...ARGON2_OPTIONS, salt: randomBytes(16) });
}

export function createAuthService({ prisma, config, jwtService }) {
  const dummyHash = hashPassword('not-a-real-password');

  async function createUser(input, options = {}) {
    const payload = validateCreateUserRequest(input);
    const allowAdminRole = typeof options === 'boolean' ? options : options.allowAdminRole === true;
    if (payload.role === 'ADMIN' && !allowAdminRole) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Administrator accounts can only be created through the bootstrap script',
      );
    }

    try {
      const outcome = await serializable(prisma, async (tx) => {
        if (await tx.user.findUnique({ where: { employeeId: payload.employeeId } })) {
          return { error: duplicateEmployeeId() };
        }
        if (await tx.user.findUnique({ where: { email: payload.email } })) {
          return { error: duplicateEmail() };
        }
        const passwordHash = await hashPassword(payload.password);
        const user = await tx.user.create({
          data: {
            employeeId: payload.employeeId,
            employeeName: payload.employeeName,
            email: payload.email,
            passwordHash,
            role: payload.role,
            isActive: true,
            locationTrackingEnabled: payload.locationTrackingEnabled,
          },
        });
        return { user };
      });
      if (outcome.error) throw outcome.error;
      return outcome.user;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error?.code === 'P2002') {
        const target = uniqueTarget(error);
        if (target.includes('employee')) throw duplicateEmployeeId();
        if (target.includes('email')) throw duplicateEmail();
      }
      throw error;
    }
  }

  async function login(input, { userAgent = null, ipAddress = null } = {}) {
    const payload = validateLoginRequest(input);
    const outcome = await serializable(prisma, async (tx) => {
      const user = await tx.user.findUnique({ where: { employeeId: payload.employeeId } });
      if (!user) {
        await verifyPassword(payload.password, await dummyHash);
        return { error: invalidCredentials() };
      }

      const now = new Date();
      const lockedUntil = dateValue(user.lockedUntil);
      if (user.lockedUntil && lockedUntil > now.getTime()) {
        await verifyPassword(payload.password, await dummyHash);
        return { error: invalidCredentials() };
      }

      const expiredLock = Boolean(user.lockedUntil) && lockedUntil <= now.getTime();
      const attempts = expiredLock ? 0 : user.noOfAttempts;
      if (!user.isActive) {
        await verifyPassword(payload.password, await dummyHash);
        if (expiredLock) {
          await tx.user.update({
            where: { id: user.id },
            data: { noOfAttempts: 0, lockedUntil: null, updatedAt: now },
          });
        }
        return { error: invalidCredentials() };
      }

      const passwordMatches = await verifyPassword(payload.password, user.passwordHash);
      if (!passwordMatches || user.role !== payload.role) {
        const nextAttempts = attempts + 1;
        await tx.user.update({
          where: { id: user.id },
          data: {
            noOfAttempts: nextAttempts,
            lockedUntil: nextAttempts >= MAX_LOGIN_ATTEMPTS
              ? new Date(now.getTime() + LOCKOUT_MS)
              : null,
            updatedAt: now,
          },
        });
        return { error: invalidCredentials() };
      }

      const updatedUser = await tx.user.update({
        where: { id: user.id },
        data: {
          noOfAttempts: 0,
          lockedUntil: null,
          lastLoginAt: now,
          updatedAt: now,
        },
      });
      await tx.activeSession.updateMany({
        where: { userId: user.id, isRevoked: false },
        data: { isRevoked: true },
      });

      const refreshToken = jwtService.generateRefreshToken();
      const session = await tx.activeSession.create({
        data: {
          userId: user.id,
          refreshTokenHash: jwtService.hashRefreshToken(refreshToken),
          previousRefreshTokenHash: null,
          userAgent,
          ipAddress,
          isRevoked: false,
          expiresAt: new Date(now.getTime() + config.jwt.refreshTokenExpireSeconds * 1000),
        },
      });
      return { user: updatedUser, session, refreshToken };
    });

    if (outcome.error) throw outcome.error;
    return {
      user: outcome.user,
      refreshToken: outcome.refreshToken,
      accessToken: jwtService.createAccessToken(
        outcome.user.id,
        outcome.session.id,
        outcome.user.role,
      ),
    };
  }

  async function refresh(refreshToken, { userAgent = null } = {}) {
    const tokenHash = jwtService.hashRefreshToken(refreshToken);
    const outcome = await serializable(prisma, async (tx) => {
      const session = await tx.activeSession.findUnique({
        where: { refreshTokenHash: tokenHash },
      });
      const now = new Date();

      if (!session) {
        const reused = await tx.activeSession.findUnique({
          where: { previousRefreshTokenHash: tokenHash },
        });
        if (reused) {
          await tx.activeSession.updateMany({
            where: { userId: reused.userId, isRevoked: false },
            data: { isRevoked: true },
          });
        }
        return { error: invalidRefreshToken() };
      }

      if (session.isRevoked || dateValue(session.expiresAt) <= now.getTime()) {
        if (!session.isRevoked) {
          await tx.activeSession.update({
            where: { id: session.id },
            data: { isRevoked: true, updatedAt: now },
          });
        }
        return { error: invalidRefreshToken() };
      }

      const user = await tx.user.findUnique({ where: { id: session.userId } });
      if (!user || !user.isActive) {
        await tx.activeSession.update({
          where: { id: session.id },
          data: { isRevoked: true, updatedAt: now },
        });
        return { error: invalidRefreshToken() };
      }

      const rotated = jwtService.generateRefreshToken();
      await tx.activeSession.update({
        where: { id: session.id },
        data: {
          previousRefreshTokenHash: session.refreshTokenHash,
          refreshTokenHash: jwtService.hashRefreshToken(rotated),
          userAgent,
          expiresAt: new Date(now.getTime() + config.jwt.refreshTokenExpireSeconds * 1000),
          updatedAt: now,
        },
      });
      return { user, sessionId: session.id, refreshToken: rotated };
    });

    if (outcome.error) throw outcome.error;
    return {
      user: outcome.user,
      refreshToken: outcome.refreshToken,
      accessToken: jwtService.createAccessToken(
        outcome.user.id,
        outcome.sessionId,
        outcome.user.role,
      ),
    };
  }

  async function logout(sessionId) {
    await prisma.activeSession.updateMany({
      where: { id: sessionId },
      data: { isRevoked: true, updatedAt: new Date() },
    });
  }

  async function logoutAll(userId) {
    await prisma.activeSession.updateMany({
      where: { userId, isRevoked: false },
      data: { isRevoked: true },
    });
  }

  return Object.freeze({
    createUser,
    login,
    refresh,
    logout,
    logoutAll,
    hashPassword,
    verifyPassword,
  });
}

export { invalidCredentials, invalidRefreshToken };
