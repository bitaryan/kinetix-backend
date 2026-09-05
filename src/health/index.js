import express from 'express';

import { failure, sendSuccess } from '../common/api.js';

export function createHealthRouter({ prisma }) {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    try {
      await prisma.user.count();
      return sendSuccess(res, { status: 'ok' });
    } catch {
      console.error('Health check database ping failed');
      return res.status(503).json(failure('SERVICE_UNAVAILABLE', 'Database is unavailable'));
    }
  });

  return router;
}
