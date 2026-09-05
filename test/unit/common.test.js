import assert from 'node:assert/strict';
import test from 'node:test';

import { formatDateLong, formatDateShort, parseDate } from '../../src/common/dates.js';
import { ApiError } from '../../src/common/api.js';
import { numberValue, pageParams } from '../../src/common/validation.js';
import { RateLimiter } from '../../src/security/rate-limiter.js';

test('date parsing stays UTC-safe across every accepted contract format', () => {
  assert.equal(formatDateShort(parseDate('25/07/26')), '25/07/26');
  assert.equal(formatDateShort(parseDate('25/07/2026')), '25/07/26');
  assert.equal(formatDateLong(parseDate('2026-07-25')), '25/07/2026');
  assert.throws(() => parseDate('31/02/2026'), ApiError);
});

function isValidationError(error) {
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 422);
  assert.equal(error.code, 'VALIDATION_ERROR');
  assert.equal(error.message, 'Request data is invalid');
  return true;
}

test('numeric validation rejects arrays, objects, and booleans instead of coercing them', () => {
  const invalid = [
    [], [27], ['27'], [null], {}, { valueOf: () => 27 },
    true, false, 27n, Symbol('27'), () => 27,
  ];
  for (const value of invalid) {
    assert.throws(() => numberValue(value), isValidationError);
    assert.throws(() => numberValue(value, { required: false }), isValidationError);
  }
});

test('numeric validation treats blank strings as absent and preserves scalar numeric strings', () => {
  for (const value of [undefined, null, '', ' ', '\t\n']) {
    assert.throws(() => numberValue(value), isValidationError);
    assert.equal(numberValue(value, { required: false }), null);
  }
  for (const [value, expected] of [[0, 0], [27.5, 27.5], [' 27.5 ', 27.5], ['-180', -180], ['1e2', 100]]) {
    assert.equal(numberValue(value), expected);
  }
  for (const value of [NaN, Infinity, -Infinity, 'NaN', 'Infinity', '12px']) {
    assert.throws(() => numberValue(value), isValidationError);
  }
  assert.throws(() => numberValue('90.1', { max: 90 }), isValidationError);
  assert.throws(() => numberValue('-1', { min: 0 }), isValidationError);
  assert.throws(() => numberValue('1.5', { integer: true }), isValidationError);
});

test('pagination accepts scalar query values but rejects repeated numeric query parameters', () => {
  assert.deepEqual(pageParams({}), { page: 1, limit: 20 });
  assert.deepEqual(pageParams({ page: '2', limit: ' 50 ' }), { page: 2, limit: 50 });
  for (const query of [
    { page: ['2'] }, { limit: ['50'] }, { page: [] }, { limit: true },
    { page: ' ' }, { page: '0' }, { limit: '101' }, { page: '1.5' },
    { page: '9007199254740992' }, { page: '2147483648', limit: '2' },
  ]) {
    assert.throws(() => pageParams(query), isValidationError);
  }
});

test('rate limiting uses a sliding request bucket', () => {
  const limiter = new RateLimiter({
    trustedProxyIps: [],
    loginRateLimitPerMinute: 2,
    refreshRateLimitPerMinute: 2,
    locationPingRateLimitPerMinute: 2,
  });
  limiter.hit('login:local', 2);
  limiter.hit('login:local', 2);
  assert.throws(() => limiter.hit('login:local', 2), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'RATE_LIMITED');
    return true;
  });
});
