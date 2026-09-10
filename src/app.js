import cookieParser from 'cookie-parser';
import express from 'express';

import { createAttendanceService } from './attendance/service.js';
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
import { createTelemetry, instrumentRoutes, metricsAuthorized } from './operations/telemetry.js';
import { createReportingRouter } from './reporting/router.js';
import { createUserManagementRouter } from './users/router.js';
import { createWorkflowRouter } from './workflows/router.js';
import { createWorkflowEvents } from './workflows/events.js';
import { createWorkflowService } from './workflows/service.js';

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
  const workflow = createWorkflowService({ prisma, config });
  const app = express();
  const telemetry = options.telemetry ?? createTelemetry({
    log: config.requestLogs ? (entry) => console.log(JSON.stringify(entry)) : undefined,
  });

  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(telemetry.middleware);
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
    `${config.apiV2Prefix}/auth/forgot-password`,
    `${config.apiV2Prefix}/auth/reset-password`,
  ]);
  app.use((req, res, next) => {
    const pathname = req.path.replace(/\/$/, '');
    const publicRequest = (req.method === 'POST' && publicJsonPaths.has(pathname))
      || (req.method === 'GET' && ['/health', '/livez', '/readyz'].includes(pathname))
      || (req.method === 'GET' && pathname === '/metrics' && config.metricsToken)
      || pathname === '/ws' || pathname.startsWith('/ws/');
    if (publicRequest || !req.is('application/json')) return parseJson(req, res, next);
    // Authentication must win over malformed/oversized protected JSON bodies,
    // just as the former servlet security filter ran before DTO parsing.
    return authenticate(req, res, (error) => (
      error ? next(error) : parseJson(req, res, next)
    ));
  });
  app.use(cookieParser());

  if (config.metricsToken) app.get('/metrics', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!metricsAuthorized(req.get('Authorization'), config.metricsToken)) {
      return res.status(401).json(failure('UNAUTHORIZED', 'Metrics authentication is required'));
    }
    let deliveryMetrics = '';
    if (config.notificationWebhookUrl) {
      const where = { deliveredAt: null, failedAt: null };
      const [pending, failed, oldest] = await Promise.all([
        prisma.deliveryJob.count({ where }),
        prisma.deliveryJob.count({ where: { failedAt: { not: null } } }),
        prisma.deliveryJob.findFirst({ where, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      ]);
      deliveryMetrics = `# HELP gpss_delivery_pending Queued notification deliveries.\n# TYPE gpss_delivery_pending gauge\ngpss_delivery_pending ${pending}\n`
        + `# HELP gpss_delivery_failed Terminally failed notification deliveries.\n# TYPE gpss_delivery_failed gauge\ngpss_delivery_failed ${failed}\n`
        + `# HELP gpss_delivery_oldest_seconds Age of the oldest pending delivery.\n# TYPE gpss_delivery_oldest_seconds gauge\ngpss_delivery_oldest_seconds ${oldest ? Math.max(0, (Date.now() - oldest.createdAt) / 1000) : 0}\n`;
    }
    return res.type('text/plain; version=0.0.4').send(telemetry.render() + deliveryMetrics);
  });

  app.use('/health', instrumentRoutes(createHealthRouter({ prisma }), '/health'));
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
  app.use(`${config.apiV1Prefix}/auth`, instrumentRoutes(auth.router, `${config.apiV1Prefix}/auth`));

  // Attendance and live routers retain their full paths to make their shared
  // admin routes explicit. Business routers are mounted at their feature roots.
  const attendance = createAttendanceService({ prisma, config, liveHub, now: options.attendanceNow,
    onAcceptedPoint: workflow.evaluateGeofences });
  app.use(instrumentRoutes(createAttendanceRouter({ prisma, config, rateLimiter, auth: featureAuth, liveHub,
    service: attendance })));
  app.use(instrumentRoutes(createLiveRouter({ prisma, config, auth: featureAuth, liveHub })));
  app.use(`${config.apiV1Prefix}/leaves`, instrumentRoutes(createLeaveRouter({ prisma, config, auth: featureAuth, events: createWorkflowEvents(config) }), `${config.apiV1Prefix}/leaves`));
  app.use(`${config.apiV1Prefix}/client-logs`, instrumentRoutes(createClientLogRouter({ prisma, config, auth: featureAuth }), `${config.apiV1Prefix}/client-logs`));
  app.use('/uploads', instrumentRoutes(createUploadRouter({ prisma, config, auth: featureAuth }), '/uploads'));
  for (const router of [
    createUserManagementRouter({ prisma, config, auth: featureAuth, rateLimiter, liveHub }),
    createReportingRouter({ prisma, auth: featureAuth, rateLimiter }),
    createWorkflowRouter({ prisma, config, auth: featureAuth }),
  ]) app.use(config.apiV2Prefix, instrumentRoutes(router, config.apiV2Prefix));

  // Spring authenticated every non-public request before resolving a handler.
  // Preserve that behavior for unknown routes too, while keeping /ws public at
  // the HTTP layer because authentication occurs in the STOMP CONNECT frame.
  app.use('/ws', routeNotFound);
  app.use(authenticate, routeNotFound);
  app.use(errorHandler);
  instrumentRoutes(app);

  return Object.freeze({ app, config, prisma, rateLimiter, auth, liveHub, telemetry, attendance });
}

export function createApp(options = {}) {
  return createApplication(options).app;
}
