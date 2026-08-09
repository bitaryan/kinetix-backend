import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_session
from app.core.errors import APIError
from app.core.security import decode_access_token, utc_now
from app.models.user import User, UserRole
from app.modules.auth.repository import ActiveSessionRepository, UserRepository

bearer_scheme = HTTPBearer(auto_error=False, description="Paste a GPSS access token.")
DbSession = Annotated[AsyncSession, Depends(get_db_session)]


@dataclass(frozen=True, slots=True)
class CurrentPrincipal:
    user: User
    session_id: uuid.UUID


async def get_current_principal(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    db: DbSession,
) -> CurrentPrincipal:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise APIError(401, "UNAUTHORIZED", "A bearer access token is required")

    claims = decode_access_token(credentials.credentials)
    active_session = await ActiveSessionRepository(db).find_by_id(claims.session_id)
    if (
        active_session is None
        or active_session.user_id != claims.user_id
        or active_session.is_revoked
        or active_session.expires_at <= utc_now()
    ):
        raise APIError(401, "UNAUTHORIZED", "Access session is no longer active")

    user = await UserRepository(db).find_by_id(claims.user_id)
    if user is None or not user.is_active:
        raise APIError(401, "UNAUTHORIZED", "User account is unavailable")
    return CurrentPrincipal(user=user, session_id=claims.session_id)


def require_roles(*allowed_roles: UserRole) -> Callable[..., CurrentPrincipal]:
    """Return a FastAPI dependency that applies role-based access control."""

    async def role_dependency(
        principal: Annotated[CurrentPrincipal, Depends(get_current_principal)],
    ) -> CurrentPrincipal:
        if principal.user.role not in allowed_roles:
            raise APIError(403, "FORBIDDEN", "You do not have permission for this action")
        return principal

    return role_dependency
