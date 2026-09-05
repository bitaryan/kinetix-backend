import express from 'express';

import { ApiError, sendSuccess } from '../common/api.js';
import { userProfile } from './service.js';

export const REFRESH_COOKIE_NAME = 'refresh_token';

function sameSiteLabel(value) {
  return value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase();
}

function refreshCookie(config, value, maxAge) {
  const attributes = [
    `${REFRESH_COOKIE_NAME}=${value}`,
    `Path=${config.cookie.path}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
  ];
  if (config.cookie.secure) attributes.push('Secure');
  attributes.push(`SameSite=${sameSiteLabel(config.cookie.sameSite)}`);
  return attributes.join('; ');
}

export function setRefreshCookie(res, config, value) {
  res.append(
    'Set-Cookie',
    refreshCookie(config, value, config.jwt.refreshTokenExpireSeconds),
  );
}

export function clearRefreshCookie(res, config) {
  res.append('Set-Cookie', refreshCookie(config, '', 0));
}

function rawCookieValue(req, name) {
  if (req.cookies && Object.hasOwn(req.cookies, name)) return req.cookies[name];
  const header = req.headers?.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

function asyncRoute(handler) {
  return function wrappedRoute(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function createAuthRouter({ service, authentication, config, rateLimiter }) {
  const router = express.Router();

  router.post('/login', asyncRoute(async (req, res) => {
    await rateLimiter.enforceLogin(req);
    const issued = await service.login(req.body, {
      userAgent: req.get('User-Agent') ?? null,
      ipAddress: rateLimiter.clientIp(req),
    });
    setRefreshCookie(res, config, issued.refreshToken);
    return sendSuccess(res, {
      accessToken: issued.accessToken,
      tokenType: 'bearer',
      expiresIn: config.jwt.accessTokenExpireSeconds,
      user: userProfile(issued.user),
    });
  }));

  router.post('/refresh', asyncRoute(async (req, res) => {
    await rateLimiter.enforceRefresh(req);
    const token = rawCookieValue(req, REFRESH_COOKIE_NAME);
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is missing');
    }
    const issued = await service.refresh(token, {
      userAgent: req.get('User-Agent') ?? null,
    });
    setRefreshCookie(res, config, issued.refreshToken);
    return sendSuccess(res, {
      accessToken: issued.accessToken,
      tokenType: 'bearer',
      expiresIn: config.jwt.accessTokenExpireSeconds,
    });
  }));

  router.post('/logout', authentication.authenticate, asyncRoute(async (req, res) => {
    await service.logout(req.principal.sessionId);
    clearRefreshCookie(res, config);
    return sendSuccess(res, { message: 'Successfully logged out' });
  }));

  router.post('/logout-all', authentication.authenticate, asyncRoute(async (req, res) => {
    await service.logoutAll(req.principal.user.id);
    clearRefreshCookie(res, config);
    return sendSuccess(res, { message: 'Successfully logged out from all devices' });
  }));

  router.get('/me', authentication.authenticate, (req, res) => (
    sendSuccess(res, userProfile(req.principal.user))
  ));

  router.post(
    '/users',
    authentication.authenticate,
    authentication.requireRoles('ADMIN'),
    asyncRoute(async (req, res) => {
      const user = await service.createUser(req.body, { allowAdminRole: false });
      return sendSuccess(res, userProfile(user), 201);
    }),
  );

  return router;
}
