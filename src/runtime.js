import http from 'node:http';
import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';

import { startAutoPunchOutScheduler } from './attendance/auto-punch-out.js';
import { createApplication } from './app.js';
import { loadConfig } from './config/env.js';
import { createPrisma } from './db/prisma.js';
import { attachLiveWebSocket } from './live/index.js';
import { createRedisInfrastructure } from './live/redis.js';

export async function startServer({
  config = loadConfig(),
  prisma = createPrisma(config),
  redis = config.redisUrl ? createRedisInfrastructure(config) : undefined,
  host = '0.0.0.0',
  port = config.port,
} = {}) {
  let ready = false;
  let server;
  let application;
  let liveSocket;
  let stopping;
  let attendanceScheduler;

  function stop() {
    if (stopping) return stopping;
    ready = false;
    stopping = (async () => {
      liveSocket?.detach();
      if (server?.listening) {
        let deadline;
        try {
          await new Promise((resolve) => {
            deadline = setTimeout(() => { server.closeAllConnections(); resolve(); }, config.shutdownTimeoutMs);
            server.close(resolve);
            server.closeIdleConnections();
          });
        } finally {
          clearTimeout(deadline);
        }
      }
      await attendanceScheduler?.stop();
      application?.liveHub.close?.();
      redis?.close();
      await prisma.$disconnect();
    })();
    return stopping;
  }

  try {
    await mkdir(config.uploadDir, { recursive: true });
    await access(config.uploadDir, constants.R_OK | constants.W_OK | constants.X_OK);
    await prisma.$connect();
    // Connecting alone does not detect an absent application schema.
    await prisma.user.count();
    // The last table in the additive migration must exist before serving V2
    // or V1 mutations that now write transactional workflow events.
    await prisma.geofenceState.count();
    await redis?.connect();
    application = createApplication({ config, prisma, redis, isReady: () => ready });
    await application.attendance.autoPunchOut();
    attendanceScheduler = startAutoPunchOutScheduler({ run: () => application.attendance.autoPunchOut() });
    server = http.createServer({
      requestTimeout: 60_000,
      headersTimeout: 15_000,
      keepAliveTimeout: 5_000,
    }, application.app);
    server.maxRequestsPerSocket = 1000;
    server.setTimeout(120_000, (socket) => socket.destroy());
    liveSocket = attachLiveWebSocket({ server, auth: application.auth, liveHub: application.liveHub, config, telemetry: application.telemetry });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(); });
    });
    server.on('error', () => {
      ready = false;
      process.exitCode = 1;
      console.error('HTTP server failed');
      stop().catch(() => { process.exitCode = 1; });
    });
    ready = true;
    return Object.freeze({ ...application, server, redis, stop });
  } catch (error) {
    await stop();
    throw error;
  }
}
