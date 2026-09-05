import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import jwt from 'jsonwebtoken';

import { ApiError } from '../../src/common/api.js';
import { setRefreshCookie } from '../../src/auth/router.js';
import {
  ARGON2_OPTIONS,
  createAuthService,
  hashPassword,
  validateCreateUserRequest,
} from '../../src/auth/service.js';
import { createAuthentication } from '../../src/security/auth.js';
import { createJwtService } from '../../src/security/jwt.js';
import express from 'express';
import request from 'supertest';
import { createAuthRouter } from '../../src/auth/router.js';
import { errorHandler } from '../../src/common/api.js';

const config = {
  jwt: {
    secret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    issuer: 'gpss-backend',
    audience: 'gpss-client',
    accessTokenExpireSeconds: 900,
    refreshTokenExpireSeconds: 7 * 24 * 60 * 60,
  },
};

function fakePrisma(user) {
  const sessions = [];
  const models = {
    user: {
      async findUnique({ where }) {
        if (where.id !== undefined) return where.id === user.id ? user : null;
        if (where.employeeId !== undefined) return where.employeeId === user.employeeId ? user : null;
        if (where.email !== undefined) return where.email === user.email ? user : null;
        return null;
      },
      async update({ where, data }) {
        assert.equal(where.id, user.id);
        Object.assign(user, data);
        return { ...user };
      },
    },
    activeSession: {
      async findUnique({ where }) {
        if (where.id !== undefined) return sessions.find((item) => item.id === where.id) ?? null;
        if (where.refreshTokenHash !== undefined) {
          return sessions.find((item) => item.refreshTokenHash === where.refreshTokenHash) ?? null;
        }
        if (where.previousRefreshTokenHash !== undefined) {
          return sessions.find((item) => item.previousRefreshTokenHash === where.previousRefreshTokenHash) ?? null;
        }
        return null;
      },
      async create({ data }) {
        const session = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...data };
        sessions.push(session);
        return { ...session };
      },
      async update({ where, data }) {
        const session = sessions.find((item) => item.id === where.id);
        if (!session) throw new Error('missing fake session');
        Object.assign(session, data);
        return { ...session };
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const session of sessions) {
          if (where.id !== undefined && session.id !== where.id) continue;
          if (where.userId !== undefined && session.userId !== where.userId) continue;
          if (where.isRevoked !== undefined && session.isRevoked !== where.isRevoked) continue;
          Object.assign(session, data);
          count += 1;
        }
        return { count };
      },
    },
  };
  return {
    ...models,
    sessions,
    async $transaction(operation) {
      return operation(models);
    },
  };
}

test('JWTs are issued as HS256 with the required access claims', () => {
  const service = createJwtService(config);
  const userId = randomUUID();
  const sessionId = randomUUID();
  const token = service.createAccessToken(userId, sessionId, 'MANAGER');
  const complete = jwt.decode(token, { complete: true });

  assert.equal(complete.header.alg, 'HS256');
  assert.deepEqual(complete.payload.aud, ['gpss-client']);
  assert.equal(complete.payload.sub, userId);
  assert.equal(complete.payload.sid, sessionId);
  assert.equal(complete.payload.role, 'MANAGER');
  assert.equal(complete.payload.nbf, complete.payload.iat);
  assert.equal(complete.payload.exp - complete.payload.iat, 900);
  assert.deepEqual(service.decodeAccessToken(token), { userId, sessionId, role: 'MANAGER' });

  const refresh = service.generateRefreshToken();
  assert.equal(refresh.length, 64);
  assert.match(service.hashRefreshToken(refresh), /^[0-9a-f]{64}$/);

  const legacy = jwt.sign(
    { sid: sessionId, role: 'MANAGER', aud: ['gpss-client'], nbf: Math.floor(Date.now() / 1000) },
    config.jwt.secret,
    {
      algorithm: 'HS512',
      issuer: 'gpss-backend',
      subject: userId,
      expiresIn: 900,
    },
  );
  assert.deepEqual(service.decodeAccessToken(legacy), { userId, sessionId, role: 'MANAGER' });
});

test('new passwords use the Java-compatible Argon2id costs', async () => {
  const encoded = await hashPassword('Correct-pass-12');
  assert.match(encoded, /^\$argon2id\$v=19\$/);
  assert.match(encoded, new RegExp(`m=${ARGON2_OPTIONS.memoryCost}`));
  assert.match(encoded, /(?:^|,)t=2(?:,|\$)/);
  assert.match(encoded, /(?:^|,)p=1(?:,|\$)/);
  assert.equal(validateCreateUserRequest({
    userId: ' emp1001 ',
    employeeName: ' Employee ',
    email: 'employee@example.com',
    password: 'Correct-pass-12',
  }).role, 'EMPLOYEE');
  assert.throws(
    () => validateCreateUserRequest({
      userId: 'EMP1001',
      employeeName: 'Employee',
      email: 'employee@example.com',
      password: 'aaaaaaaaaaaa',
    }),
    ApiError,
  );
});

test('failed login state commits and refresh-token reuse revokes the session', async () => {
  const user = {
    id: randomUUID(),
    employeeId: 'EMP1001',
    employeeName: 'Employee',
    email: 'employee@example.com',
    passwordHash: await hashPassword('Employee-pass-12'),
    role: 'EMPLOYEE',
    isActive: true,
    noOfAttempts: 0,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const prisma = fakePrisma(user);
  const jwtService = createJwtService(config);
  const service = createAuthService({ prisma, config, jwtService });

  await assert.rejects(
    service.login({ userId: 'emp1001', password: 'wrong-password-xx', role: 'EMPLOYEE' }),
    (error) => error.code === 'INVALID_CREDENTIALS',
  );
  assert.equal(user.noOfAttempts, 1);

  const login = await service.login({
    userId: 'EMP1001',
    password: 'Employee-pass-12',
    role: 'EMPLOYEE',
  });
  assert.equal(user.noOfAttempts, 0);
  const refreshed = await service.refresh(login.refreshToken, { userAgent: 'unit-test' });
  assert.notEqual(refreshed.refreshToken, login.refreshToken);

  await assert.rejects(
    service.refresh(login.refreshToken),
    (error) => error.code === 'INVALID_REFRESH_TOKEN',
  );
  assert.equal(prisma.sessions[0].isRevoked, true);

  const authentication = createAuthentication({ prisma, jwtService });
  await assert.rejects(
    authentication.authenticateToken(refreshed.accessToken),
    (error) => error.message === 'Access session is no longer active',
  );
});

test('auth router preserves the refresh-cookie attributes', () => {
  const routerConfig = {
    ...config,
    cookie: { secure: false, sameSite: 'strict', path: '/api/v1/auth' },
  };
  const headers = [];
  const res = {
    append(name, value) {
      headers.push([name, value]);
    },
  };
  setRefreshCookie(res, routerConfig, 'refresh-token');
  assert.equal(headers[0][0], 'Set-Cookie');
  assert.match(headers[0][1], /^refresh_token=refresh-token;/);
  assert.match(headers[0][1], /Path=\/api\/v1\/auth/);
  assert.match(headers[0][1], /Max-Age=604800/);
  assert.match(headers[0][1], /HttpOnly/);
  assert.match(headers[0][1], /SameSite=Strict/);
});

test('create-user validation rejects database length overflow before hashing or persistence', () => {
  const input = {
    userId: 'EMP001', employeeName: 'Employee', email: 'employee@example.com',
    password: 'Correct-pass-12',
  };
  for (const change of [
    { email: `${'a'.repeat(244)}@example.com` },
    { userId: 'ß'.repeat(16) },
  ]) {
    assert.throws(() => validateCreateUserRequest({ ...input, ...change }), {
      status: 422, code: 'VALIDATION_ERROR',
    });
  }
});

test('auth endpoints await asynchronous rate limiting before issuing any credentials', async () => {
  const events = [];
  const rateLimiter = {
    async enforceLogin() {
      await new Promise((resolve) => setImmediate(resolve));
      events.push('login limited');
      throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Please try again later');
    },
    async enforceRefresh() {
      await new Promise((resolve) => setImmediate(resolve));
      events.push('refresh limited');
      throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Please try again later');
    },
    clientIp() { return '127.0.0.1'; },
  };
  const service = {
    login() { assert.fail('Rate-limited login must not reach the service'); },
    refresh() { assert.fail('Rate-limited refresh must not rotate tokens'); },
  };
  const authentication = {
    authenticate(_req, _res, next) { next(); },
    requireRoles() { return (_req, _res, next) => next(); },
  };
  const app = express();
  app.use(express.json());
  app.use('/auth', createAuthRouter({ service, authentication, config, rateLimiter }));
  app.use(errorHandler);
  await request(app).post('/auth/login').send({}).expect(429);
  await request(app).post('/auth/refresh').set('Cookie', 'refresh_token=token').expect(429);
  assert.deepEqual(events, ['login limited', 'refresh limited']);
});
