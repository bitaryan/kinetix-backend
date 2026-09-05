import { randomUUID } from 'node:crypto';

import { ApiError } from '../common/api.js';
import { RateLimiter } from './rate-limiter.js';

// One atomic decision across both GPS buckets. Redis time keeps all replicas
// on the same sliding window, and keys expire without a cleanup process.
const SLIDING_WINDOW = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local cost = tonumber(ARGV[1])
for index, key in ipairs(KEYS) do
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now - 60000)
  if redis.call('ZCARD', key) + cost > tonumber(ARGV[index + 2]) then
    return 0
  end
end
for _, key in ipairs(KEYS) do
  for item = 1, cost do
    redis.call('ZADD', key, now, ARGV[2] .. ':' .. item)
  end
  redis.call('PEXPIRE', key, 60000)
end
return 1
`;

export class RedisRateLimiter extends RateLimiter {
  constructor(config, redis) {
    super(config);
    this.redis = redis;
  }

  async consume(buckets, cost = 1) {
    const active = buckets.filter((bucket) => bucket.limit > 0);
    if (!active.length || cost <= 0) return;
    const accepted = await this.redis.execute((client) => client.eval(SLIDING_WINDOW, {
      keys: active.map(({ key }) => `${this.config.redisKeyPrefix}:rate:${key}`),
      arguments: [String(cost), randomUUID(), ...active.map(({ limit }) => String(limit))],
    }));
    if (accepted !== 1) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Please try again later');
    }
  }

  hit(key, limit, cost = 1) {
    return this.consume([{ key, limit }], cost);
  }

  enforceLocationPing(req, userId) {
    const limit = this.config.locationPingRateLimitPerMinute;
    return this.consume([
      { key: `locping:user:${userId}`, limit },
      { key: `locping:ip:${this.clientIp(req)}`, limit: limit * 100 },
    ]);
  }
}
