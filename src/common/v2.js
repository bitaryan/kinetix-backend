import { ApiError, validationError } from './api.js';
import { parseDate } from './dates.js';
import { pageParams, requireObject, stringValue, uuidValue } from './validation.js';

export function strictBody(value, keys) {
  const body = requireObject(value);
  if (Object.keys(body).some((key) => !keys.includes(key))) throw validationError();
  return body;
}

export function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw validationError();
  return parseDate(value);
}

export function dateRange(query, now = new Date()) {
  const endDate = query.to ? isoDate(query.to) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const startDate = query.from ? isoDate(query.from) : new Date(endDate.getTime() - 29 * 86400000);
  if (endDate < startDate || endDate - startDate > 365 * 86400000) {
    throw validationError('Date range must be ordered and no longer than 366 days');
  }
  return { startDate, endDate, until: new Date(endDate.getTime() + 86400000) };
}

export function userScope(actor, userId) {
  const selected = userId === undefined ? undefined : uuidValue(userId);
  if (actor.role === 'EMPLOYEE') {
    if (selected && selected !== actor.id) throw new ApiError(404, 'NOT_FOUND', 'User not found');
    return actor.id;
  }
  return selected;
}

export function listOptions(query) {
  return { ...pageParams(query), search: stringValue(query.search, { required: false, max: 80 }) };
}

export function containsLiteral(search) {
  return { contains: search.replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' };
}

export function paginated(data, total, { page, limit }) {
  return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function readPage(db, model, where, options, extra = {}) {
  return db.$transaction(async (tx) => {
    const total = await tx[model].count({ where });
    const data = await tx[model].findMany({ where, skip: (options.page - 1) * options.limit,
      take: options.limit, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...extra });
    return paginated(data, total, options);
  }, { isolationLevel: 'RepeatableRead' });
}
