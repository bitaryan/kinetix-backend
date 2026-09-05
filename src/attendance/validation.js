import { Prisma } from '@prisma/client';

import { ApiError, validationError } from '../common/api.js';
import {
  booleanValue,
  enumValue,
  numberValue,
  requireObject,
  stringValue,
  uuidValue,
} from '../common/validation.js';

const MAX_ODO = new Prisma.Decimal('9999999.99');
const AWARE_ISO = /^([+-]\d{4,9}|\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{0,9}))?)?([Zz]|[+-]\d{2}(?::\d{2}(?::\d{2})?)?)$/;

function decimalOdometer(value) {
  if (value === undefined || value === null || value === '' || typeof value === 'boolean') {
    throw validationError();
  }
  let parsed;
  try {
    parsed = new Prisma.Decimal(String(value).trim());
  } catch {
    throw validationError();
  }
  if (!parsed.isFinite() || parsed.lessThan(0) || parsed.greaterThan(MAX_ODO)) {
    throw validationError();
  }
  return parsed.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

function multipartFile(files, name) {
  const file = Array.isArray(files?.[name]) ? files[name][0] : files?.[name];
  if (!file) throw validationError();
  return file;
}

export function parseOptionalPunchInstant(raw, now) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return new Date(now.getTime());
  }
  const parsed = tryParseAwareInstant(raw);
  if (parsed === null) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'capturedAt must include a timezone offset');
  }
  return parsed;
}

export function tryParseAwareInstant(raw) {
  if (typeof raw !== 'string') return null;
  const match = AWARE_ISO.exec(raw.trim());
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', offset] = match;
  const [year, month, day, hour, minute, second] = [
    yearText, monthText, dayText, hourText, minuteText, secondText ?? '0',
  ].map(Number);
  if ((yearText.startsWith('+') && yearText.length < 6)
      || (yearText.startsWith('-') && year === 0)) return null;

  // Match the historical Instant.parse (upper-case Z) / OffsetDateTime.parse
  // split, including offset seconds. Date.parse alone accepts non-ISO strings
  // and silently rolls invalid calendar dates into the next month.
  const usesInstantParser = offset === 'Z';
  if (usesInstantParser && secondText === undefined) return null;
  const midnightRollover = usesInstantParser && hour === 24 && minute === 0
    && second === 0 && !/[1-9]/.test(fraction);
  const leapSecond = usesInstantParser && hour === 23 && minute === 59 && second === 60;
  if ((!midnightRollover && hour > 23) || minute > 59 || (!leapSecond && second > 59)) return null;

  let offsetSeconds = 0;
  if (offset !== 'Z' && offset !== 'z') {
    const [offsetHours, offsetMinutes = 0, offsetRemainder = 0] = offset.slice(1).split(':').map(Number);
    if (offsetHours > 18 || offsetMinutes > 59 || offsetRemainder > 59
        || (offsetHours === 18 && (offsetMinutes !== 0 || offsetRemainder !== 0))) return null;
    offsetSeconds = (offsetHours * 3600 + offsetMinutes * 60 + offsetRemainder)
      * (offset.startsWith('-') ? -1 : 1);
  }
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1
      || local.getUTCDate() !== day) return null;
  local.setUTCHours(hour, minute, leapSecond ? 59 : second, Number(fraction.slice(0, 3).padEnd(3, '0')));
  const parsed = new Date(local.getTime() - offsetSeconds * 1000);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function baseMultipart(body) {
  return {
    latitude: numberValue(body?.latitude, { min: -90, max: 90 }),
    longitude: numberValue(body?.longitude, { min: -180, max: 180 }),
    accuracy: numberValue(body?.accuracy, { required: false, min: 0 }),
    capturedAt: body?.capturedAt,
  };
}

export function parsePunchInRequest(req) {
  const common = baseMultipart(req.body);
  return {
    selfie: multipartFile(req.files, 'selfie'),
    openingOdoImage: multipartFile(req.files, 'openingOdoImage'),
    openingOdoKm: decimalOdometer(req.body?.openingOdoKm),
    ...common,
  };
}

export function parsePunchOutRequest(req) {
  const common = baseMultipart(req.body);
  return {
    closingOdoImage: multipartFile(req.files, 'closingOdoImage'),
    closingOdoKm: decimalOdometer(req.body?.closingOdoKm),
    ...common,
  };
}

export function parseLocationPingPoint(value) {
  const body = requireObject(value);
  return {
    latitude: numberValue(body.latitude, { min: -90, max: 90 }),
    longitude: numberValue(body.longitude, { min: -180, max: 180 }),
    accuracy: numberValue(body.accuracy, { required: false, min: 0 }),
    capturedAt: stringValue(body.capturedAt, { min: 1 }),
    battery: numberValue(body.battery, { required: false, min: 0, max: 100 }),
    speed: numberValue(body.speed, { required: false, min: 0 }),
    clientEventId: uuidValue(body.clientEventId, { required: false }),
    isMock: booleanValue(body.isMock, { required: false }),
  };
}

export function parseLocationPingRequest(value) {
  const body = requireObject(value);
  return {
    sessionId: uuidValue(body.sessionId),
    ...parseLocationPingPoint(body),
  };
}

export function parseLocationPingBatchRequest(value) {
  const body = requireObject(value);
  if (!Array.isArray(body.pings) || body.pings.length === 0) throw validationError();
  return {
    sessionId: uuidValue(body.sessionId),
    pings: body.pings.map(parseLocationPingPoint),
  };
}

export function parseLocationSettingsUpdate(value) {
  const body = requireObject(value);
  return { locationMode: enumValue(body.locationMode, ['continuous', 'single']) };
}

export function decimalToFixed(value) {
  if (value === null || value === undefined) return null;
  return new Prisma.Decimal(value).toFixed(2);
}
