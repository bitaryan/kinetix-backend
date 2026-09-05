import { validationError } from './api.js';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const TIMEZONE_PATTERN = /(?:[zZ]|[+-]\d{2}:\d{2})$/;

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requireObject(value) {
  if (!isObject(value)) throw validationError();
  return value;
}

export function stringValue(value, { required = true, trim = true, min = 0, max = Infinity } = {}) {
  if (value === undefined || value === null) {
    if (required) throw validationError();
    return null;
  }
  if (typeof value !== 'string') throw validationError();
  const result = trim ? value.trim() : value;
  if (result.length < min || result.length > max) throw validationError();
  return result;
}

export function numberValue(value, {
  required = true,
  min = -Infinity,
  max = Infinity,
  integer = false,
} = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (required) throw validationError();
    return null;
  }
  if (typeof value !== 'number' && typeof value !== 'string') throw validationError();
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(result) || result < min || result > max || (integer && !Number.isSafeInteger(result))) {
    throw validationError();
  }
  return result;
}

export function booleanValue(value, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw validationError();
    return null;
  }
  if (typeof value !== 'boolean') throw validationError();
  return value;
}

export function uuidValue(value, { required = true } = {}) {
  const result = stringValue(value, { required, trim: true });
  if (result === null) return null;
  if (!UUID_PATTERN.test(result)) throw validationError();
  return result.toLowerCase();
}

export function enumValue(value, allowed, { required = true } = {}) {
  const result = stringValue(value, { required });
  if (result === null) return null;
  if (!allowed.includes(result)) throw validationError();
  return result;
}

export function parseOffsetInstant(value, { required = true, timezoneMessage } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw validationError();
    return null;
  }
  if (typeof value !== 'string') throw validationError();
  if (!TIMEZONE_PATTERN.test(value.trim())) {
    throw validationError(timezoneMessage);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw validationError();
  return parsed;
}

export function pageParams(query, defaultLimit = 20) {
  const result = {
    page: numberValue(query.page ?? 1, { min: 1, integer: true }),
    limit: numberValue(query.limit ?? defaultLimit, { min: 1, max: 100, integer: true }),
  };
  // Prisma's pagination arguments use signed 32-bit integers. Reject values
  // that cannot be represented before a malformed page can become a DB error.
  if ((result.page - 1) * result.limit > 2_147_483_647) throw validationError();
  return result;
}
