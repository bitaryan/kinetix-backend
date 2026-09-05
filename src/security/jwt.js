import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';

import { ApiError } from '../common/api.js';
import { UUID_PATTERN } from '../common/validation.js';

const ROLES = new Set(['ADMIN', 'MANAGER', 'EMPLOYEE']);

function invalidAccessToken() {
  return new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired access token');
}

function acceptedAlgorithms(secret) {
  const bytes = Buffer.byteLength(secret, 'utf8');
  const algorithms = ['HS256'];
  // Java selected its signing algorithm from the raw secret length. Accept those
  // stronger legacy variants during a rolling migration, but only where Java
  // could have emitted them with this same key.
  if (bytes >= 48) algorithms.push('HS384');
  if (bytes >= 64) algorithms.push('HS512');
  return algorithms;
}

export function createJwtService(config) {
  const jwtConfig = config.jwt ?? config;
  const {
    secret,
    issuer,
    audience,
    accessTokenExpireSeconds,
  } = jwtConfig;

  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('JWT secret must be at least 32 bytes');
  }

  function createAccessToken(userId, sessionId, role) {
    return jwt.sign(
      {
        sid: sessionId,
        role,
        // JJWT serializes its audience collection as a JSON array.
        aud: [audience],
      },
      secret,
      {
        algorithm: 'HS256',
        issuer,
        subject: userId,
        expiresIn: accessTokenExpireSeconds,
        notBefore: 0,
      },
    );
  }

  function decodeAccessToken(token) {
    try {
      if (typeof token !== 'string' || token.length === 0) throw invalidAccessToken();
      const claims = jwt.verify(token, secret, {
        algorithms: acceptedAlgorithms(secret),
        issuer,
        audience,
      });
      if (typeof claims !== 'object'
          || !UUID_PATTERN.test(claims.sub ?? '')
          || !UUID_PATTERN.test(claims.sid ?? '')
          || !ROLES.has(claims.role)
          || !Number.isFinite(claims.iat)
          || !Number.isFinite(claims.nbf)
          || !Number.isFinite(claims.exp)) {
        throw invalidAccessToken();
      }
      return {
        userId: claims.sub.toLowerCase(),
        sessionId: claims.sid.toLowerCase(),
        role: claims.role,
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw invalidAccessToken();
    }
  }

  function generateRefreshToken() {
    return randomBytes(48).toString('base64url');
  }

  function hashRefreshToken(token) {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  return Object.freeze({
    createAccessToken,
    decodeAccessToken,
    generateRefreshToken,
    hashRefreshToken,
  });
}

export { invalidAccessToken };
