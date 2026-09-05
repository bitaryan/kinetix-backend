import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig, normalizeDatabaseUrl } from '../../src/config/env.js';

const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('normalizes legacy JDBC and asyncpg database URLs for Prisma', () => {
  assert.equal(
    normalizeDatabaseUrl('jdbc:postgresql://localhost:5432/gpss'),
    'postgresql://gpss:gpss@localhost:5432/gpss',
  );
  assert.equal(
    normalizeDatabaseUrl('postgresql+asyncpg://gpss:secret@db:5432/gpss'),
    'postgresql://gpss:secret@db:5432/gpss',
  );
});

test('rejects placeholder secrets', () => {
  assert.throws(
    () => loadConfig({ JWT_SECRET_KEY: 'replace-with-a-64-character-random-secret' }),
    /placeholder/,
  );
});

test('production requires secure cookies, HTTPS CORS, and database TLS', () => {
  const base = {
    APP_ENV: 'production',
    JWT_SECRET_KEY: SECRET,
    COOKIE_SECURE: 'true',
    DATABASE_URL: 'postgresql://gpss:secret@db.example/gpss?sslmode=require',
    BACKEND_CORS_ORIGINS: 'https://app.example.com',
  };
  assert.equal(loadConfig(base).cookie.secure, true);
  assert.throws(() => loadConfig({ ...base, COOKIE_SECURE: 'false' }), /COOKIE_SECURE/);
  assert.throws(
    () => loadConfig({ ...base, BACKEND_CORS_ORIGINS: 'http://app.example.com' }),
    /https/,
  );
  assert.throws(
    () => loadConfig({ ...base, DATABASE_URL: 'postgresql://gpss:secret@db.example/gpss?sslmode=disable' }),
    /enable TLS/,
  );
});

test('Prisma TLS normalization cannot silently fall back to plaintext', () => {
  for (const ssl of ['true', '1', 'require']) {
    const url = new URL(normalizeDatabaseUrl(`postgresql://gpss:secret@db/gpss?ssl=${ssl}`));
    assert.equal(url.searchParams.get('sslmode'), 'require');
    assert.equal(url.searchParams.get('sslaccept'), 'strict');
    assert.equal(url.searchParams.has('ssl'), false);
  }
  assert.equal(
    new URL(normalizeDatabaseUrl('jdbc:postgresql://db/gpss?ssl=true')).searchParams.get('sslaccept'),
    'strict',
  );
  for (const mode of ['verify-ca', 'verify-full', 'unknown']) {
    assert.throws(
      () => normalizeDatabaseUrl(`postgresql://gpss:secret@db/gpss?sslmode=${mode}`),
      /unsupported by Prisma/,
    );
  }
  for (const query of [
    'sslmode=disable&ssl=true',
    'sslmode=prefer&ssl=true',
    'sslmode=require&ssl=false',
    'ssl=true&sslaccept=accept_invalid_certs',
    'sslmode=require&sslmode=disable',
    'ssl=true&ssl=false',
    'sslaccept=strict&sslaccept=accept_invalid_certs',
    'sslaccept=invalid',
  ]) {
    assert.throws(() => normalizeDatabaseUrl(`postgresql://gpss:secret@db/gpss?${query}`));
  }
  const explicit = new URL(normalizeDatabaseUrl(
    'postgresql://gpss:secret@db/gpss?sslmode=REQUIRE&sslaccept=STRICT&sslcert=root.pem',
  ));
  assert.equal(explicit.searchParams.get('sslmode'), 'require');
  assert.equal(explicit.searchParams.get('sslaccept'), 'strict');
  assert.equal(explicit.searchParams.get('sslcert'), 'root.pem');
});

test('production CORS rejects bracketed IPv6 and trailing-dot localhost', () => {
  for (const origin of ['https://[::1]', 'https://localhost.', 'https://127.0.0.1']) {
    assert.throws(() => loadConfig({
      APP_ENV: 'production',
      JWT_SECRET_KEY: SECRET,
      COOKIE_SECURE: 'true',
      DATABASE_URL: 'postgresql://gpss:secret@db.example/gpss?sslmode=require',
      BACKEND_CORS_ORIGINS: origin,
    }), /localhost in production/);
  }
});

test('production verifies database and Redis TLS and honors NODE_ENV', () => {
  const base = {
    NODE_ENV: 'production', JWT_SECRET_KEY: SECRET, COOKIE_SECURE: 'true',
    DATABASE_URL: 'postgresql://gpss:secret@db/gpss?sslmode=require',
    BACKEND_CORS_ORIGINS: 'https://app.example.com',
  };
  assert.equal(new URL(loadConfig(base).databaseUrl).searchParams.get('sslaccept'), 'strict');
  assert.throws(() => loadConfig({ ...base, COOKIE_SECURE: 'false' }), /COOKIE_SECURE/);
  assert.throws(() => loadConfig({ ...base, DATABASE_URL: `${base.DATABASE_URL}&sslaccept=accept_invalid_certs` }), /verify certificates/);
  assert.throws(() => loadConfig({ ...base, REDIS_URL: 'redis://cache:6379' }), /rediss/);
  assert.equal(loadConfig({ ...base, REDIS_URL: 'rediss://cache:6379' }).redisUrl, 'rediss://cache:6379');
});

test('invalid runtime limits, proxy IPs, origins and Redis URLs fail at startup', () => {
  for (const values of [
    { PORT: '65536' }, { DB_POOL_SIZE: '9007199254740992' },
    { API_V1_PREFIX: '/api/*' }, { TRUSTED_PROXY_IPS: '127.0.0.1/8' },
    { LIVE_STALE_AFTER_SECONDS: '901', LIVE_OFFLINE_AFTER_SECONDS: '900' },
    { REDIS_URL: 'https://cache' }, { REDIS_URL: 'redis://cache/words' },
    { REDIS_KEY_PREFIX: 'wild*card' }, { REDIS_COMMAND_TIMEOUT_MS: '0' },
    { BACKEND_CORS_ORIGINS: 'https://app.example.com/path' },
    { BACKEND_CORS_ORIGINS: 'https://user:pass@app.example.com' },
    { DATABASE_URL: 'https://db.example.com' },
  ]) assert.throws(() => loadConfig({ JWT_SECRET_KEY: SECRET, ...values }));
});
