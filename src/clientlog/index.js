import express from 'express';
import multer from 'multer';

import { ApiError, isMalformedMultipartError, sendSuccess, validationError } from '../common/api.js';
import { formatDateLong, parseDate } from '../common/dates.js';
import { pageParams, requireObject, uuidValue } from '../common/validation.js';
import { createImageStorage } from '../upload/image-storage.js';
import { createClientLogService } from './service.js';

const MOBILE = /^[0-9]{10}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const FULL_DATE = /^\d{2}\/\d{2}\/\d{4}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLIENT_LOG_IMAGE_MESSAGE = 'Image size exceeds 5MB or invalid format';

function clientUpload(config) {
  const parser = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 16,
      parts: 17,
      fieldSize: 16 * 1024,
    },
  }).single('selfie');

  return (req, res, next) => {
    parser(req, res, (error) => {
      if (!error) return next();
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return next(new ApiError(400, 'INVALID_IMAGE', CLIENT_LOG_IMAGE_MESSAGE));
      }
      if (error instanceof multer.MulterError) return next(validationError());
      if (isMalformedMultipartError(error)) return next(validationError());
      return next(error);
    });
  };
}

function parseClientLogDate(value) {
  if (typeof value !== 'string') throw validationError();
  const text = value.trim();
  if (!FULL_DATE.test(text) && !ISO_DATE.test(text)) {
    throw validationError('Select a valid date');
  }
  try {
    return parseDate(text);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'VALIDATION_ERROR') {
      throw validationError('Select a valid date');
    }
    throw error;
  }
}

function requireName(value, message, max) {
  if (typeof value !== 'string') throw validationError(message);
  const cleaned = value.trim();
  if (cleaned.length < 2) throw validationError(message);
  if (cleaned.length > max) throw validationError();
  return cleaned;
}

function validateMobile(value) {
  if (typeof value !== 'string') {
    throw validationError('Please enter a valid 10-digit mobile number');
  }
  const cleaned = value.trim();
  if (!MOBILE.test(cleaned)) {
    throw validationError('Please enter a valid 10-digit mobile number');
  }
  return cleaned;
}

function validateEmail(value) {
  if (typeof value !== 'string') throw validationError('Please enter a valid email address');
  const cleaned = value.trim().toLowerCase();
  if (!EMAIL.test(cleaned)) throw validationError('Please enter a valid email address');
  if (cleaned.length > 255) throw validationError();
  return cleaned;
}

function optionalFloat(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw validationError();
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw validationError();
  return parsed;
}

function numberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

function listItem(log, images) {
  return {
    id: log.id,
    userId: log.userId,
    clientName: log.clientName,
    companyName: log.companyName,
    mobileNumber: log.mobileNumber,
    mailId: log.mailId,
    date: formatDateLong(log.logDate),
    selfieUrl: images.selfieUrl(log.selfiePath),
    latitude: numberOrNull(log.latitude),
    longitude: numberOrNull(log.longitude),
    locationAccuracy: log.locationAccuracy ?? null,
    createdAt: log.createdAt,
  };
}

function createdItem(log, images) {
  return {
    id: log.id,
    clientName: log.clientName,
    companyName: log.companyName,
    mobileNumber: log.mobileNumber,
    mailId: log.mailId,
    date: formatDateLong(log.logDate),
    selfieUrl: images.selfieUrl(log.selfiePath),
    latitude: numberOrNull(log.latitude),
    longitude: numberOrNull(log.longitude),
    createdAt: log.createdAt,
  };
}

export function createClientLogRouter({ prisma, config, auth, imageStorage }) {
  const router = express.Router();
  const images = imageStorage ?? createImageStorage(config);
  const service = createClientLogService({ prisma, images });
  router.use(auth.authenticate);

  router.get('/', auth.requireRoles('EMPLOYEE', 'MANAGER'), async (req, res) => {
    const { page, limit } = pageParams(req.query);
    let search = null;
    if (req.query.search !== undefined) {
      if (typeof req.query.search !== 'string' || req.query.search.length > 80) throw validationError();
      search = req.query.search.trim();
    }

    const { totalCount, logs } = await service.list(req.principal.user.id, { page, limit, search });
    const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / limit);
    return sendSuccess(
      res,
      logs.map((log) => listItem(log, images)),
      200,
      { page, limit, totalCount, totalPages },
    );
  });

  router.post(
    '/',
    auth.requireRoles('EMPLOYEE', 'MANAGER'),
    clientUpload(config),
    async (req, res) => {
      const payload = requireObject(req.body);
      const logDate = parseClientLogDate(payload.date);
      const clientName = requireName(payload.client_name, 'Please enter client name', 150);
      const companyName = requireName(payload.company_name, 'Please enter company name', 200);
      const mobileNumber = validateMobile(payload.mobile_number);
      const mailId = validateEmail(payload.mail_id);
      const latitude = optionalFloat(payload.latitude);
      const longitude = optionalFloat(payload.longitude);
      const locationAccuracy = optionalFloat(payload.accuracy);
      const log = await service.create(req.principal.user.id, {
        logDate,
        clientName,
        companyName,
        mobileNumber,
        mailId,
        latitude,
        longitude,
        locationAccuracy,
      }, req.file);
      return sendSuccess(res, createdItem(log, images), 201);
    },
  );

  router.delete('/:logId', auth.requireRoles('MANAGER', 'ADMIN'), async (req, res) => {
    const id = uuidValue(req.params.logId);
    await service.remove(req.principal.user, id);
    return sendSuccess(res, { message: 'Client log deleted successfully' });
  });

  return router;
}
