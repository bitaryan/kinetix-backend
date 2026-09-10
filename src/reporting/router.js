import express from 'express';
import { sendSuccess } from '../common/api.js';
import { enumValue } from '../common/validation.js';
import { createReportingService } from './service.js';
import { attendanceCsv, attendancePdf } from './export.js';

export function createReportingRouter({ prisma, auth, rateLimiter }) {
  const router = express.Router();
  const service = createReportingService({ prisma });
  const limitReport = async (req, _res, next) => {
    await rateLimiter.hit(`report:user:${req.principal.user.id}`, 10);
    next();
  };
  router.use(auth.authenticate, (_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
  router.get('/attendance', async (req, res) => {
    const result = await service.list(req.principal.user, req.query);
    return sendSuccess(res, result.data, 200, result.meta);
  });
  router.get('/attendance/export', limitReport, async (req, res) => {
    const format = enumValue(req.query.format ?? 'csv', ['csv', 'pdf']);
    const report = await service.report(req.principal.user, req.query);
    const content = format === 'csv' ? attendanceCsv(report) : await attendancePdf(report);
    res.setHeader('Content-Disposition', `attachment; filename="attendance.${format}"`);
    return res.type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf').send(content);
  });
  router.get('/attendance/:id', async (req, res) => sendSuccess(res, await service.detail(req.principal.user, req.params.id)));
  router.get('/attendance/:id/trail', async (req, res) => {
    const result = await service.trail(req.principal.user, req.params.id, req.query);
    return sendSuccess(res, result.data, 200, result.meta);
  });
  router.get('/reports/attendance', auth.requireRoles('ADMIN', 'MANAGER'), limitReport, async (req, res) =>
    sendSuccess(res, await service.report(req.principal.user, req.query)));
  router.get('/dashboard', auth.requireRoles('ADMIN', 'MANAGER'), async (req, res) =>
    sendSuccess(res, await service.dashboard(req.principal.user, req.query)));
  return router;
}
