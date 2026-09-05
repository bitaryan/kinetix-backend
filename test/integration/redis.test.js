import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { loadConfig } from '../../src/config/env.js';
import { createLiveLocationHub } from '../../src/live/hub.js';
import { createRedisInfrastructure } from '../../src/live/redis.js';
import { RedisRateLimiter } from '../../src/security/redis-rate-limiter.js';

const redisUrl = process.env.TEST_REDIS_URL;

if (!redisUrl) {
  test('shared infrastructure verification requires TEST_REDIS_URL', { skip: true }, () => {});
} else {
  test('two replicas share atomic rate limits and publish each committed event once', { timeout: 20_000 }, async (t) => {
    const config = loadConfig({
      APP_ENV: 'test', JWT_SECRET_KEY: 'redis-integration-secret-0123456789abcdef',
      REDIS_URL: redisUrl, REDIS_KEY_PREFIX: `gpss-test:${randomUUID()}`,
      LOGIN_RATE_LIMIT_PER_MINUTE: '2', LOCATION_PING_RATE_LIMIT_PER_MINUTE: '2',
    });
    const first = createRedisInfrastructure(config);
    const second = createRedisInfrastructure(config);
    t.after(() => { first.close(); second.close(); });
    await Promise.all([first.connect(), second.connect()]);
    const one = new RedisRateLimiter(config, first);
    const two = new RedisRateLimiter(config, second);
    const outcomes = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => (index % 2 ? one : two).hit('race', 3)));
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 3);
    assert.ok(outcomes.filter((outcome) => outcome.status === 'rejected').every((outcome) => outcome.reason.status === 429));
    const ttl = await first.execute((client) => client.pTTL(`${config.redisKeyPrefix}:rate:race`));
    assert.ok(ttl > 0 && ttl <= 60_000);
    const req = { socket: { remoteAddress: '127.0.0.1' } };
    await one.enforceLocationPing(req, 'employee');
    await two.enforceLocationPing(req, 'employee');
    await assert.rejects(one.enforceLocationPing(req, 'employee'), { status: 429 });
    assert.equal(await first.execute((client) => client.zCard(`${config.redisKeyPrefix}:rate:locping:ip:127.0.0.1`)), 2);
    // A full IP bucket must not consume the user's still-available bucket.
    await one.hit('locping:ip:127.0.0.1', 200, 198);
    await assert.rejects(two.enforceLocationPing(req, 'different-employee'), { status: 429 });
    assert.equal(await first.execute((client) => client.zCard(`${config.redisKeyPrefix}:rate:locping:user:different-employee`)), 0);

    const user = { id: 'employee', employeeId: 'EMP01', employeeName: 'Employee' };
    const session = {
      id: randomUUID(), status: 'punched_in', lastKnownLatitude: 28, lastKnownLongitude: 77,
      lastKnownAccuracy: 10, lastKnownCapturedAt: new Date(), user,
    };
    const prisma = { user: { async findUnique() { return user; } }, attendanceSession: { async findMany() { return [session]; } } };
    const localHub = createLiveLocationHub({ prisma, config, redis: first });
    const remoteHub = createLiveLocationHub({ prisma, config, redis: second });
    t.after(() => { localHub.close(); remoteHub.close(); });
    const local = [];
    const remote = [];
    localHub.subscribe((data) => local.push(data));
    let received;
    const remoteEvent = new Promise((resolve) => { received = resolve; });
    remoteHub.subscribe((data) => { remote.push(data); received(); });
    await localHub.publish(session, user.id);
    await remoteEvent;
    assert.equal(local.length, 1);
    assert.equal(remote.length, 1);
    assert.deepEqual(local[0], remote[0]);
    assert.deepEqual(await remoteHub.snapshot(), remote);
    await first.check();
    first.close();
    assert.equal(first.isReady(), false);
    await assert.rejects(one.hit('closed', 1), { status: 503 });
    await assert.rejects(first.check(), { status: 503 });
    // Delete only the known keys this fixture created; never FLUSHDB/FLUSHALL.
    await second.execute((client) => client.del(['race', 'locping:user:employee', 'locping:ip:127.0.0.1']
      .map((key) => `${config.redisKeyPrefix}:rate:${key}`)));
  });
}
