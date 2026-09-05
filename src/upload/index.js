import { createReadStream } from 'node:fs';
import path from 'node:path';

import express from 'express';

import { notFound } from '../common/api.js';
import { createUploadService } from './service.js';

const MEDIA_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);
function requestedPath(req) {
  const wildcard = req.params.relativePath;
  if (Array.isArray(wildcard)) return wildcard.join('/');
  return typeof wildcard === 'string' ? wildcard : '';
}

export function createUploadRouter({ config, auth }) {
  const router = express.Router();
  const service = createUploadService({ config });
  router.use((_req, res, next) => {
    // Files contain employee photos and locations and must not survive logout
    // in a browser or shared proxy cache.
    res.setHeader('Cache-Control', 'private, no-store');
    next();
  });
  router.use(auth.authenticate);

  router.get(['/', '/*relativePath'], async (req, res, next) => {
    const file = await service.resolveFile(req.principal.user, requestedPath(req));
    const extension = path.extname(file.absolutePath).toLowerCase();
    res.status(200);
    res.setHeader('Content-Type', MEDIA_TYPES.get(extension) ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(file.size));
    const stream = createReadStream(file.absolutePath);
    res.once('close', () => stream.destroy());
    stream.on('error', (error) => {
      if (!res.headersSent) next(notFound('File not found'));
      else res.destroy(error);
    });
    stream.pipe(res);
  });

  return router;
}

export { createImageStorage, extensionFromMagic } from './image-storage.js';
