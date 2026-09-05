import { createAuthentication } from '../security/auth.js';
import { createJwtService } from '../security/jwt.js';
import { createAuthRouter } from './router.js';
import { createAuthService } from './service.js';

/**
 * Creates the complete auth feature. Mount `router` at `${config.apiV1Prefix}/auth`.
 */
export function createAuth({ prisma, config, rateLimiter }) {
  const jwtService = createJwtService(config);
  const service = createAuthService({ prisma, config, jwtService });
  const authentication = createAuthentication({ prisma, jwtService });
  const router = createAuthRouter({ service, authentication, config, rateLimiter });

  return Object.freeze({
    router,
    service,
    jwtService,
    authenticate: authentication.authenticate,
    requireAuth: authentication.authenticate,
    requireRoles: authentication.requireRoles,
    authenticateToken: authentication.authenticateToken,
  });
}

export { createAuthRouter } from './router.js';
export { createAuthService, userProfile } from './service.js';
