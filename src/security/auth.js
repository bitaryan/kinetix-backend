import { ApiError } from '../common/api.js';

function bearerRequired() {
  return new ApiError(401, 'UNAUTHORIZED', 'A bearer access token is required');
}

function inactiveSession() {
  return new ApiError(401, 'UNAUTHORIZED', 'Access session is no longer active');
}

function unavailableUser() {
  return new ApiError(401, 'UNAUTHORIZED', 'User account is unavailable');
}

function forbidden() {
  return new ApiError(403, 'FORBIDDEN', 'You do not have permission for this action');
}

export function createAuthentication({ prisma, jwtService }) {
  async function authenticateToken(token) {
    const claims = jwtService.decodeAccessToken(token);
    const session = await prisma.activeSession.findUnique({
      where: { id: claims.sessionId },
    });

    const expiresAt = session?.expiresAt instanceof Date
      ? session.expiresAt.getTime()
      : new Date(session?.expiresAt ?? Number.NaN).getTime();
    if (!session
        || session.userId !== claims.userId
        || session.isRevoked
        || !Number.isFinite(expiresAt)
        || expiresAt <= Date.now()) {
      throw inactiveSession();
    }

    const user = await prisma.user.findUnique({ where: { id: claims.userId } });
    if (!user || !user.isActive) throw unavailableUser();

    return { user, sessionId: session.id };
  }

  async function authenticate(req, _res, next) {
    try {
      const header = req.get?.('Authorization') ?? req.headers?.authorization;
      if (typeof header !== 'string' || !/^Bearer /i.test(header)) {
        throw bearerRequired();
      }
      req.principal = await authenticateToken(header.slice(7).trim());
      next();
    } catch (error) {
      next(error);
    }
  }

  function requireRoles(...roles) {
    const allowed = new Set(roles.flat());
    return function roleMiddleware(req, _res, next) {
      if (!req.principal) {
        next(bearerRequired());
        return;
      }
      if (!allowed.has(req.principal.user.role)) {
        next(forbidden());
        return;
      }
      next();
    };
  }

  return Object.freeze({
    authenticate,
    requireAuth: authenticate,
    requireRoles,
    authenticateToken,
  });
}

export { bearerRequired, forbidden, inactiveSession, unavailableUser };
