import express from 'express';

import { sendSuccess } from '../common/api.js';
import { createLiveLocationHub } from './hub.js';

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function createLiveRouter(dependencies) {
  const { auth, config } = dependencies;
  if (typeof auth?.authenticate !== 'function' || typeof auth?.requireRoles !== 'function') {
    throw new TypeError('auth.authenticate and auth.requireRoles are required');
  }
  const liveHub = dependencies.liveHub ?? createLiveLocationHub(dependencies);
  const router = express.Router();
  const prefix = config.apiV1Prefix || '/api/v1';

  router.get(
    `${prefix}/admin/live-locations`,
    auth.authenticate,
    auth.requireRoles('ADMIN', 'MANAGER'),
    asyncRoute(async (_req, res) => sendSuccess(res, await liveHub.snapshot())),
  );
  router.liveHub = liveHub;
  return router;
}
