import express from 'express';
import { sendSuccess } from '../common/api.js';
import { clearRefreshCookie } from '../auth/router.js';
import { createUserManagementService } from './service.js';

export function createUserManagementRouter({ prisma, config, auth, rateLimiter, liveHub }) {
  const router = express.Router();
  const service = createUserManagementService({ prisma, config, liveHub });
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
  router.post('/auth/forgot-password', async (req, res) => {
    await rateLimiter.enforceLogin(req);
    return sendSuccess(res, await service.forgotPassword(req.body), 202);
  });
  router.post('/auth/reset-password', async (req, res) => {
    await rateLimiter.enforceLogin(req);
    const result = await service.resetPassword(req.body);
    clearRefreshCookie(res, config);
    return sendSuccess(res, result);
  });
  router.use(auth.authenticate);
  router.patch('/profile', async (req, res) => {
    await rateLimiter.enforceLogin(req);
    return sendSuccess(res, await service.update(req.principal.user, req.principal.user.id, req.body, true));
  });
  router.post('/auth/change-password', async (req, res) => {
    await rateLimiter.enforceLogin(req);
    const result = await service.changePassword(req.principal.user, req.body);
    clearRefreshCookie(res, config);
    return sendSuccess(res, result);
  });
  router.get('/users', auth.requireRoles('ADMIN'), async (req, res) => {
    const result = await service.list(req.query);
    return sendSuccess(res, result.data, 200, result.meta);
  });
  router.post('/users/bulk', auth.requireRoles('ADMIN'), async (req, res) => {
    await rateLimiter.enforceLogin(req);
    return sendSuccess(res, await service.bulkCreate(req.principal.user, req.body), 201);
  });
  router.get('/users/:id', auth.requireRoles('ADMIN'), async (req, res) => sendSuccess(res, await service.get(req.params.id)));
  router.patch('/users/:id', auth.requireRoles('ADMIN'), async (req, res) =>
    sendSuccess(res, await service.update(req.principal.user, req.params.id, req.body)));
  return router;
}
