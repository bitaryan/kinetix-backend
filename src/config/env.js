import path from 'node:path';
import { isIP } from 'node:net';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const DEFAULT_DATABASE_URL = 'postgresql://gpss:gpss@localhost:5432/gpss';

function integer(value, fallback, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function decimal(value, fallback, name, { min = 0 } = {}) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${name} must be a number greater than or equal to ${min}`);
  }
  return parsed;
}

function boolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (String(value).toLowerCase() === 'true') return true;
  if (String(value).toLowerCase() === 'false') return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function csv(value) {
  if (!value?.trim()) return [];
  return value
    .split(',')
    .map((item) => item.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export function normalizeDatabaseUrl(value, env = process.env) {
  let raw = value?.trim() || DEFAULT_DATABASE_URL;
  if (raw.startsWith('postgresql+asyncpg://')) {
    raw = `postgresql://${raw.slice('postgresql+asyncpg://'.length)}`;
  }
  const jdbc = raw.startsWith('jdbc:postgresql://');
  if (jdbc) raw = `postgresql://${raw.slice('jdbc:postgresql://'.length)}`;
  const url = new URL(raw);
  if (!['postgresql:', 'postgres:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use PostgreSQL');
  }
  if (jdbc) {
    if (!url.username) url.username = env.DATABASE_USER || env.DB_USER || 'gpss';
    if (!url.password) url.password = env.DATABASE_PASSWORD || env.DB_PASSWORD || 'gpss';
  }
  for (const name of ['ssl', 'sslmode', 'sslaccept']) {
    if (url.searchParams.getAll(name).length > 1) {
      throw new Error(`DATABASE_URL must not repeat ${name}`);
    }
  }
  let mode = url.searchParams.get('sslmode')?.toLowerCase();
  if (mode !== undefined && !['disable', 'prefer', 'require'].includes(mode)) {
    // Prisma 6 silently treats libpq verify-* modes as prefer. Do not weaken
    // certificate-verification intent by passing those unsupported modes on.
    throw new Error('DATABASE_URL sslmode is unsupported by Prisma; use sslmode=require with sslaccept=strict and the required certificate settings');
  }
  const accept = url.searchParams.get('sslaccept')?.toLowerCase();
  if (accept !== undefined && !['strict', 'accept_invalid_certs'].includes(accept)) {
    throw new Error('DATABASE_URL sslaccept must be strict or accept_invalid_certs');
  }
  const legacySsl = url.searchParams.get('ssl')?.toLowerCase();
  if (legacySsl !== undefined) {
    const enabled = ['true', '1', 'require'].includes(legacySsl);
    const disabled = ['false', '0', 'disable'].includes(legacySsl);
    if (!enabled && !disabled) throw new Error('DATABASE_URL ssl value is unsupported');
    const legacyMode = enabled ? 'require' : 'disable';
    if (mode !== undefined && mode !== legacyMode) {
      throw new Error('DATABASE_URL contains conflicting ssl and sslmode settings');
    }
    if (enabled && accept === 'accept_invalid_certs') {
      throw new Error('DATABASE_URL legacy ssl requires sslaccept=strict; configure Prisma TLS settings explicitly');
    }
    mode = legacyMode;
    // JDBC ssl=true includes certificate verification. Preserve that intent,
    // and translate the flag Prisma otherwise ignores into enforced TLS.
    if (enabled) url.searchParams.set('sslaccept', 'strict');
    url.searchParams.delete('ssl');
  } else if (accept !== undefined) {
    url.searchParams.set('sslaccept', accept);
  }
  if (mode !== undefined) url.searchParams.set('sslmode', mode);
  return url.toString();
}

export function loadConfig(env = process.env) {
  const appEnv = env.APP_ENV?.trim() || env.NODE_ENV?.trim() || 'development';
  const secret = env.JWT_SECRET_KEY?.trim() || '';
  const cookieSecure = boolean(env.COOKIE_SECURE, false);
  const cookieSameSite = (env.COOKIE_SAMESITE?.trim() || 'strict').toLowerCase();
  const corsOrigins = csv(env.BACKEND_CORS_ORIGINS ?? 'http://localhost:3000,http://localhost:5173');
  let databaseUrl = normalizeDatabaseUrl(env.DATABASE_URL, env);
  const redisUrl = env.REDIS_URL?.trim() || null;
  const redisKeyPrefix = env.REDIS_KEY_PREFIX?.trim() || 'gpss';
  if (!/^[A-Za-z0-9:_-]{1,80}$/.test(redisKeyPrefix)) {
    throw new Error('REDIS_KEY_PREFIX must be 1–80 letters, digits, colons, underscores or hyphens');
  }
  if (redisUrl) {
    let parsed;
    try { parsed = new URL(redisUrl); } catch { throw new Error('REDIS_URL must be a valid Redis URL'); }
    if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname
        || !/^\/(?:\d+)?$/.test(parsed.pathname || '/') || parsed.search || parsed.hash) {
      throw new Error('REDIS_URL must use redis:// or rediss:// with an optional database number');
    }
  }
  const trustedProxyIps = csv(env.TRUSTED_PROXY_IPS || '');
  if (trustedProxyIps.some((ip) => !isIP(ip))) {
    throw new Error('TRUSTED_PROXY_IPS must contain exact IP addresses');
  }
  for (const origin of corsOrigins) {
    let parsed;
    try { parsed = new URL(origin); } catch { throw new Error('BACKEND_CORS_ORIGINS must contain exact HTTP(S) origins'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error('BACKEND_CORS_ORIGINS must contain exact HTTP(S) origins without paths or credentials');
    }
  }

  if (secret.length < 32) {
    throw new Error('JWT_SECRET_KEY must be at least 32 characters');
  }
  if (secret.toLowerCase() === 'replace-with-a-64-character-random-secret'
      || secret.toLowerCase().startsWith('replace-')) {
    throw new Error('JWT_SECRET_KEY must not use a placeholder value');
  }
  if (!['strict', 'lax', 'none'].includes(cookieSameSite)) {
    throw new Error('COOKIE_SAMESITE must be strict, lax, or none');
  }
  if (cookieSameSite === 'none' && !cookieSecure) {
    throw new Error('COOKIE_SECURE must be true when COOKIE_SAMESITE is none');
  }
  if ((env.JWT_ALGORITHM?.trim() || 'HS256') !== 'HS256') {
    throw new Error('JWT_ALGORITHM must be HS256');
  }

  if (appEnv.toLowerCase() === 'production') {
    if (!cookieSecure) {
      throw new Error('COOKIE_SECURE must be true when APP_ENV is production');
    }
    const parsedDatabaseUrl = new URL(databaseUrl);
    if (parsedDatabaseUrl.searchParams.get('sslmode') !== 'require') {
      throw new Error('DATABASE_URL must enable TLS (ssl or sslmode) when APP_ENV is production');
    }
    if (parsedDatabaseUrl.searchParams.get('sslaccept') === 'accept_invalid_certs') {
      throw new Error('Production DATABASE_URL must verify certificates with sslaccept=strict');
    }
    parsedDatabaseUrl.searchParams.set('sslaccept', 'strict');
    databaseUrl = parsedDatabaseUrl.toString();
    if (redisUrl && new URL(redisUrl).protocol !== 'rediss:') {
      throw new Error('Production REDIS_URL must use rediss:// for verified TLS');
    }
    if (corsOrigins.length === 0) {
      throw new Error('BACKEND_CORS_ORIGINS must be set when APP_ENV is production');
    }
    for (const origin of corsOrigins) {
      if (origin === '*') {
        throw new Error('BACKEND_CORS_ORIGINS must not include * with cookies');
      }
      const parsed = new URL(origin);
      if (parsed.protocol !== 'https:') {
        throw new Error('BACKEND_CORS_ORIGINS must use https when APP_ENV is production');
      }
      const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
      if (['localhost', '127.0.0.1', '::1'].includes(hostname)) {
        throw new Error('BACKEND_CORS_ORIGINS must not use localhost in production');
      }
    }
  }

  const apiV1Prefix = (env.API_V1_PREFIX?.trim() || '/api/v1').replace(/\/$/, '');
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(apiV1Prefix)) {
    throw new Error('API_V1_PREFIX must be an absolute path without route patterns');
  }
  const liveStaleAfterSeconds = integer(env.LIVE_STALE_AFTER_SECONDS, 120, 'LIVE_STALE_AFTER_SECONDS');
  const liveOfflineAfterSeconds = integer(env.LIVE_OFFLINE_AFTER_SECONDS, 900, 'LIVE_OFFLINE_AFTER_SECONDS');
  if (liveOfflineAfterSeconds < liveStaleAfterSeconds) {
    throw new Error('LIVE_OFFLINE_AFTER_SECONDS must be greater than or equal to LIVE_STALE_AFTER_SECONDS');
  }
  const accessTokenExpireMinutes = integer(
    env.ACCESS_TOKEN_EXPIRE_MINUTES,
    15,
    'ACCESS_TOKEN_EXPIRE_MINUTES',
    { min: 1 },
  );
  const refreshTokenExpireDays = integer(
    env.REFRESH_TOKEN_EXPIRE_DAYS,
    7,
    'REFRESH_TOKEN_EXPIRE_DAYS',
    { min: 1 },
  );

  const metricsToken = env.METRICS_TOKEN?.trim() || null;
  if (metricsToken && (metricsToken.length < 32 || /\s/.test(metricsToken))) throw new Error('METRICS_TOKEN must be at least 32 characters without whitespace');
  const notificationWebhookUrl = env.NOTIFICATION_WEBHOOK_URL?.trim() || null;
  const notificationWebhookSecret = env.NOTIFICATION_WEBHOOK_SECRET?.trim() || null;
  const deliveryEncryptionKey = env.DELIVERY_ENCRYPTION_KEY?.trim() || null;
  const passwordResetUrl = env.PASSWORD_RESET_URL?.trim() || null;
  for (const [name, value] of [['NOTIFICATION_WEBHOOK_URL', notificationWebhookUrl], ['PASSWORD_RESET_URL', passwordResetUrl]]) {
    if (!value) continue;
    let url;
    try { url = new URL(value); } catch { throw new Error(`${name} must be an HTTPS URL`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error(`${name} must be an HTTPS URL without credentials or a fragment`);
  }
  if (notificationWebhookUrl && (!notificationWebhookSecret || notificationWebhookSecret.length < 32 || !/^[a-f0-9]{64}$/i.test(deliveryEncryptionKey ?? ''))) {
    throw new Error('Delivery requires NOTIFICATION_WEBHOOK_SECRET (32+ characters) and DELIVERY_ENCRYPTION_KEY (64 hex characters)');
  }
  if (passwordResetUrl && !notificationWebhookUrl) throw new Error('PASSWORD_RESET_URL requires notification delivery');

  return Object.freeze({
    appName: env.APP_NAME?.trim() || 'GPSS Backend',
    appEnv,
    port: integer(env.PORT, 8080, 'PORT', { min: 1, max: 65535 }),
    shutdownTimeoutMs: integer(env.SHUTDOWN_TIMEOUT_MS, 30_000, 'SHUTDOWN_TIMEOUT_MS', { min: 1000, max: 120_000 }),
    apiV1Prefix,
    apiV2Prefix: '/api/v2',
    requestLogs: boolean(env.REQUEST_LOGS, appEnv.toLowerCase() === 'production'),
    metricsToken,
    notificationWebhookUrl,
    notificationWebhookSecret,
    deliveryEncryptionKey,
    passwordResetUrl,
    geofencesEnabled: boolean(env.GEOFENCES_ENABLED, false),
    databaseUrl,
    redisUrl,
    redisKeyPrefix,
    redisCommandTimeoutMs: integer(env.REDIS_COMMAND_TIMEOUT_MS, 5000, 'REDIS_COMMAND_TIMEOUT_MS', { min: 100, max: 30_000 }),
    databasePoolSize: integer(env.DB_POOL_SIZE, 20, 'DB_POOL_SIZE', { min: 1 }),
    databaseConnectionTimeoutSeconds: integer(
      env.DB_POOL_TIMEOUT_SECONDS,
      30,
      'DB_POOL_TIMEOUT_SECONDS',
      { min: 1 },
    ),
    jwt: Object.freeze({
      secret,
      algorithm: 'HS256',
      issuer: env.JWT_ISSUER?.trim() || 'gpss-backend',
      audience: env.JWT_AUDIENCE?.trim() || 'gpss-client',
      accessTokenExpireMinutes,
      accessTokenExpireSeconds: accessTokenExpireMinutes * 60,
      refreshTokenExpireDays,
      refreshTokenExpireSeconds: refreshTokenExpireDays * 24 * 60 * 60,
    }),
    cookie: Object.freeze({
      secure: cookieSecure,
      sameSite: cookieSameSite,
      path: `${apiV1Prefix}/auth`,
    }),
    corsOrigins: Object.freeze(corsOrigins),
    trustedProxyIps: Object.freeze(trustedProxyIps),
    loginRateLimitPerMinute: integer(
      env.LOGIN_RATE_LIMIT_PER_MINUTE,
      120,
      'LOGIN_RATE_LIMIT_PER_MINUTE',
    ),
    refreshRateLimitPerMinute: integer(
      env.REFRESH_RATE_LIMIT_PER_MINUTE,
      300,
      'REFRESH_RATE_LIMIT_PER_MINUTE',
    ),
    locationPingRateLimitPerMinute: integer(
      env.LOCATION_PING_RATE_LIMIT_PER_MINUTE,
      120,
      'LOCATION_PING_RATE_LIMIT_PER_MINUTE',
    ),
    locationPingMinIntervalSeconds: decimal(
      env.LOCATION_PING_MIN_INTERVAL_SECONDS,
      5,
      'LOCATION_PING_MIN_INTERVAL_SECONDS',
    ),
    locationPingMaxPerSession: integer(
      env.LOCATION_PING_MAX_PER_SESSION,
      6000,
      'LOCATION_PING_MAX_PER_SESSION',
      { min: 1 },
    ),
    locationPingBatchMax: integer(
      env.LOCATION_PING_BATCH_MAX,
      120,
      'LOCATION_PING_BATCH_MAX',
      { min: 1 },
    ),
    locationPingMaxAccuracyMeters: decimal(
      env.LOCATION_PING_MAX_ACCURACY_METERS,
      100,
      'LOCATION_PING_MAX_ACCURACY_METERS',
    ),
    liveStaleAfterSeconds,
    liveOfflineAfterSeconds,
    uploadDir: path.resolve(env.UPLOAD_DIR?.trim() || 'uploads'),
    maxUploadBytes: integer(env.MAX_UPLOAD_BYTES, 5 * 1024 * 1024, 'MAX_UPLOAD_BYTES', { min: 1 }),
    publicBaseUrl: (env.PUBLIC_BASE_URL?.trim() || '').replace(/\/$/, ''),
  });
}
