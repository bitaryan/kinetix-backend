import express from 'express';
import { sendSuccess } from '../common/api.js';
import { createWorkflowService } from './service.js';

export function createWorkflowRouter({ prisma, config, auth }) {
  const router = express.Router();
  const service = createWorkflowService({ prisma, config });
  const admin = auth.requireRoles('ADMIN');
  const supervisor = auth.requireRoles('ADMIN', 'MANAGER');
  const page = (res, result) => sendSuccess(res, result.data, 200, result.meta);
  router.use(auth.authenticate, (_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
  router.get('/leaves', async (req, res) => page(res, await service.listLeaves(req.principal.user, req.query)));
  router.get('/leaves/balance', async (req, res) => sendSuccess(res, await service.balance(req.principal.user, req.query)));
  router.post('/leaves/:id/cancel', async (req, res) => sendSuccess(res, await service.cancel(req.principal.user, req.params.id, req.body)));
  router.get('/leaves/:id/history', async (req, res) => page(res, await service.history(req.principal.user, req.params.id, req.query)));
  router.get('/policy', async (req, res) => sendSuccess(res, await service.policy(req.principal.user)));
  router.put('/policy', admin, async (req, res) => sendSuccess(res, await service.updatePolicy(req.principal.user, req.body)));
  router.put('/users/:id/leave-entitlement', admin, async (req, res) => sendSuccess(res, await service.entitlement(req.principal.user, req.params.id, req.body)));
  router.get('/holidays', async (req, res) => sendSuccess(res, await service.holidays(req.query)));
  router.put('/holidays', admin, async (req, res) => sendSuccess(res, await service.putHoliday(req.principal.user, req.body)));
  router.delete('/holidays/:id', admin, async (req, res) => sendSuccess(res, await service.deleteHoliday(req.principal.user, req.params.id)));
  router.get('/notifications', async (req, res) => page(res, await service.notifications(req.principal.user, req.query)));
  router.patch('/notifications/:id/read', async (req, res) => sendSuccess(res, await service.readNotification(req.principal.user, req.params.id)));
  router.get('/audit-events', admin, async (req, res) => page(res, await service.auditEvents(req.query)));
  router.get('/geofences', supervisor, async (req, res) => page(res, await service.geofences(req.query)));
  router.post('/geofences', admin, async (req, res) => sendSuccess(res, await service.saveGeofence(req.principal.user, null, req.body), 201));
  router.put('/geofences/:id', admin, async (req, res) => sendSuccess(res, await service.saveGeofence(req.principal.user, req.params.id, req.body)));
  return router;
}
