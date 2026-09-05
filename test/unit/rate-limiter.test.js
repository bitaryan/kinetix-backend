import assert from 'node:assert/strict';
import test from 'node:test';

import { RateLimiter } from '../../src/security/rate-limiter.js';
import { RedisRateLimiter } from '../../src/security/redis-rate-limiter.js';

test('proxy rate limits ignore spoofed hops and normalize mapped IPv4 peers', () => {
  const limiter = new RateLimiter({ trustedProxyIps: ['127.0.0.1', '10.0.0.1'] });
  const req = (peer, header) => ({ socket: { remoteAddress: peer }, get() { return header; } });
  assert.equal(limiter.clientIp(req('198.51.100.1', '1.2.3.4')), '198.51.100.1');
  assert.equal(limiter.clientIp(req('::ffff:127.0.0.1', '1.2.3.4, 198.51.100.1, 10.0.0.1')), '198.51.100.1');
  assert.equal(limiter.clientIp(req('127.0.0.1', 'not-an-ip')), '127.0.0.1');
  assert.equal(limiter.clientIp(req('127.0.0.1', '::ffff:198.51.100.1')), '198.51.100.1');
});

test('shared rate limiting propagates infrastructure failures and never bypasses checks', async () => {
  const error = Object.assign(new Error('Unavailable'), { status: 503 });
  const limiter = new RedisRateLimiter({ trustedProxyIps: [], loginRateLimitPerMinute: 2 }, {
    async execute() { throw error; },
  });
  await assert.rejects(limiter.enforceLogin({ socket: { remoteAddress: '127.0.0.1' } }), { status: 503 });
});
