import express from 'express';
import multer from 'multer';

import { ApiError, isMalformedMultipartError, sendSuccess, validationError } from '../common/api.js';
import { createAttendanceService, toPunchOutData, toPunchSessionData } from './service.js';
import {
  parseLocationPingBatchRequest,
  parseLocationPingRequest,
  parseLocationSettingsUpdate,
  parsePunchInRequest,
  parsePunchOutRequest,
} from './validation.js';

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function principalUserId(req) {
  const principal = req.principal ?? req.auth ?? req.user;
  const userId = principal?.user?.id ?? principal?.userId ?? principal?.id;
  if (!userId) {
    throw new ApiError(401, 'UNAUTHORIZED', 'A bearer access token is required');
  }
  return userId;
}

function requireAuthApi(auth) {
  if (typeof auth?.authenticate !== 'function' || typeof auth?.requireRoles !== 'function') {
    throw new TypeError('auth.authenticate and auth.requireRoles are required');
  }
}

export function createAttendanceRouter(dependencies) {
  const {
    auth,
    config,
    rateLimiter,
  } = dependencies;
  requireAuthApi(auth);
  const service = dependencies.service ?? createAttendanceService(dependencies);
  const router = express.Router();
  const prefix = config.apiV1Prefix || '/api/v1';
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.maxUploadBytes,
      fieldSize: 16 * 1024,
      fields: 16,
      files: 2,
      parts: 20,
    },
  });
  const fieldStaff = auth.requireRoles('EMPLOYEE', 'MANAGER');
  const admin = auth.requireRoles('ADMIN');
  function multipart(fields) {
    const parse = upload.fields(fields);
    return (req, res, next) => parse(req, res, (error) => {
      next(isMalformedMultipartError(error) ? validationError() : error);
    });
  }

  router.post(
    `${prefix}/attendance/punch-in`,
    auth.authenticate,
    fieldStaff,
    multipart([
      { name: 'selfie', maxCount: 1 },
      { name: 'openingOdoImage', maxCount: 1 },
    ]),
    asyncRoute(async (req, res) => {
      const request = parsePunchInRequest(req);
      const result = await service.punchIn(principalUserId(req), request);
      return sendSuccess(res, toPunchSessionData(result.session, result.locationMode), 201);
    }),
  );

  router.get(
    `${prefix}/attendance/current`,
    auth.authenticate,
    fieldStaff,
    asyncRoute(async (req, res) => {
      const userId = principalUserId(req);
      const locationMode = await service.resolveLocationMode();
      const session = await service.current(userId);
      return sendSuccess(res, {
        punchedIn: session !== null,
        session: session === null ? null : toPunchSessionData(session, locationMode),
        locationMode,
      });
    }),
  );

  router.post(
    `${prefix}/attendance/location-ping`,
    auth.authenticate,
    fieldStaff,
    asyncRoute(async (req, res) => {
      const request = parseLocationPingRequest(req.body);
      const userId = principalUserId(req);
      await rateLimiter.enforceLocationPing(req, userId);
      return sendSuccess(res, await service.locationPing(userId, request));
    }),
  );

  router.post(
    `${prefix}/attendance/location-pings`,
    auth.authenticate,
    fieldStaff,
    asyncRoute(async (req, res) => {
      const request = parseLocationPingBatchRequest(req.body);
      const userId = principalUserId(req);
      // Java's current V2 limiter deliberately charges one token per HTTP call.
      await rateLimiter.enforceLocationPing(req, userId);
      return sendSuccess(res, await service.locationPingBatch(userId, request));
    }),
  );

  router.post(
    `${prefix}/attendance/punch-out`,
    auth.authenticate,
    fieldStaff,
    multipart([{ name: 'closingOdoImage', maxCount: 1 }]),
    asyncRoute(async (req, res) => {
      const request = parsePunchOutRequest(req);
      const session = await service.punchOut(principalUserId(req), request);
      if (!session.punchedOutAt) {
        throw new ApiError(500, 'INTERNAL_ERROR', 'Punch-out completed without a timestamp');
      }
      return sendSuccess(res, toPunchOutData(session));
    }),
  );

  router.get(
    `${prefix}/admin/location-settings`,
    auth.authenticate,
    admin,
    asyncRoute(async (_req, res) => sendSuccess(res, {
      locationMode: await service.resolveLocationMode(),
    })),
  );

  router.patch(
    `${prefix}/admin/location-settings`,
    auth.authenticate,
    admin,
    asyncRoute(async (req, res) => {
      const { locationMode } = parseLocationSettingsUpdate(req.body);
      return sendSuccess(res, { locationMode: await service.updateLocationMode(locationMode) });
    }),
  );

  // Exposed for integration tests and explicit cache invalidation; Express ignores custom properties.
  router.attendanceService = service;
  return router;
}
