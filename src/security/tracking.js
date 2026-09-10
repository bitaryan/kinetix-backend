import { ApiError } from '../common/api.js';

export function trackingEnabled(user) {
  return user?.locationTrackingEnabled === true;
}

export function requiresOdometer(user, session) {
  return trackingEnabled(user) && (!session || session.openingOdoKm != null);
}

export function trackingAllowedAt(user, capturedAt) {
  return trackingEnabled(user) && (!user.locationTrackingSince || capturedAt >= user.locationTrackingSince);
}

export async function trackingUser(db, id) {
  const user = await db.user.findUnique({ where: { id } });
  if (!user || user.isActive === false) throw new ApiError(401, 'UNAUTHORIZED', 'User account is unavailable');
  return user;
}
