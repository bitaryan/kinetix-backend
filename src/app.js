import cookieParser from 'cookie-parser';
import express from 'express';

import { createAttendanceRouter } from './attendance/index.js';
import { createAuth } from './auth/index.js';
import { createClientLogRouter } from './clientlog/index.js';
import { errorHandler, failure, routeNotFound, sendSuccess } from './common/api.js';
import { loadConfig } from './config/env.js';
import { getPrisma } from './db/prisma.js';
import { createHealthRouter } from './health/index.js';
import { createLeaveRouter } from './leave/index.js';
import { createLiveLocationHub, createLiveRouter } from './live/index.js';
import { corsMiddleware, securityHeaders } from './middleware/http.js';
import { RateLimiter } from './security/rate-limiter.js';
import { RedisRateLimiter } from './security/redis-rate-limiter.js';
import { createUploadRouter } from './upload/index.js';

export function createApplication(options = {}) {
  const config = options.config ?? loadConfig();
  const prisma = options.prisma ?? getPrisma(config);
  if (config.redisUrl && !options.redis && !options.rateLimiter) {
    throw new Error('Configured Redis infrastructure must be connected before creating the application');
  }
  const rateLimiter = options.rateLimiter ?? (options.redis
    ? new RedisRateLimiter(config, options.redis) : new RateLimiter(config));
  const auth = options.auth ?? createAuth({ prisma, config, rateLimiter });
  const authenticatedRequests = new WeakSet();
  const authenticate = (req, res, next) => {
    if (authenticatedRequests.has(req)) return next();
    return auth.authenticate(req, res, (error) => {
      if (!error) authenticatedRequests.add(req);
      return next(error);
    });
  };
  const featureAuth = { ...auth, authenticate, requireAuth: authenticate };
  const liveHub = options.liveHub ?? createLiveLocationHub({ prisma, config, redis: options.redis });
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(securityHeaders(config));
  app.use(corsMiddleware(config));
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });
  const parseJson = express.json();
  const publicJsonPaths = new Set([
    `${config.apiV1Prefix}/auth/login`,
    `${config.apiV1Prefix}/auth/refresh`,
  ]);
  app.use((req, res, next) => {
    const pathname = req.path.replace(/\/$/, '');
    const publicRequest = (req.method === 'POST' && publicJsonPaths.has(pathname))
      || (req.method === 'GET' && ['/health', '/livez', '/readyz'].includes(pathname))
      || pathname === '/ws' || pathname.startsWith('/ws/');
    if (publicRequest || !req.is('application/json')) return parseJson(req, res, next);
    // Authentication must win over malformed/oversized protected JSON bodies,
    // just as the former servlet security filter ran before DTO parsing.
    return authenticate(req, res, (error) => (
      error ? next(error) : parseJson(req, res, next)
    ));
  });
  app.use(cookieParser());

  app.use('/health', createHealthRouter({ prisma }));
  app.get('/livez', (_req, res) => sendSuccess(res, { status: 'ok' }));
  app.get('/readyz', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (options.isReady && !options.isReady()) throw new Error('Not ready');
      await prisma.user.count();
      await options.redis?.check();
      return sendSuccess(res, { status: 'ok' });
    } catch {
      return res.status(503).json(failure('SERVICE_UNAVAILABLE', 'Service is not ready'));
    }
  });
  app.use(`${config.apiV1Prefix}/auth`, auth.router);

  // Attendance and live routers retain their full paths to make their shared
  // admin routes explicit. Business routers are mounted at their feature roots.
  app.use(createAttendanceRouter({ prisma, config, rateLimiter, auth: featureAuth, liveHub }));
  app.use(createLiveRouter({ prisma, config, auth: featureAuth, liveHub }));
  app.use(`${config.apiV1Prefix}/leaves`, createLeaveRouter({ prisma, config, auth: featureAuth }));
  app.use(`${config.apiV1Prefix}/client-logs`, createClientLogRouter({ prisma, config, auth: featureAuth }));
  app.use('/uploads', createUploadRouter({ prisma, config, auth: featureAuth }));

  // Spring authenticated every non-public request before resolving a handler.
  // Preserve that behavior for unknown routes too, while keeping /ws public at
  // the HTTP layer because authentication occurs in the STOMP CONNECT frame.
  app.use('/ws', routeNotFound);
  app.use(authenticate, routeNotFound);
  app.use(errorHandler);

  return Object.freeze({ app, config, prisma, rateLimiter, auth, liveHub });
}

export function createApp(options = {}) {
  return createApplication(options).app;
}
