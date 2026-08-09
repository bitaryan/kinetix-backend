import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import APIError
from app.core.security import (
    create_access_token,
    generate_refresh_token,
    hash_password,
    hash_refresh_token,
    utc_now,
    verify_dummy_password,
    verify_password,
)
from app.models.session import ActiveSession
from app.models.user import User, UserRole
from app.modules.auth.repository import ActiveSessionRepository, UserRepository
from app.modules.auth.schemas import CreateUserRequest, LoginRequest

settings = get_settings()
MAX_LOGIN_ATTEMPTS = 5
LOCKOUT_DURATION = timedelta(minutes=15)


def _invalid_credentials() -> APIError:
    return APIError(401, "INVALID_CREDENTIALS", "Invalid user ID or password")


@dataclass(frozen=True, slots=True)
class IssuedTokens:
    access_token: str
    refresh_token: str
    user: User


class AuthService:
    """Authentication business rules; repositories remain free of business logic."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.users = UserRepository(db)
        self.sessions = ActiveSessionRepository(db)

    async def create_user(
        self, payload: CreateUserRequest, *, allow_admin_role: bool = False
    ) -> User:
        if payload.role is UserRole.ADMIN and not allow_admin_role:
            raise APIError(
                403,
                "FORBIDDEN",
                "Administrator accounts can only be created through the bootstrap script",
            )
        if await self.users.find_by_employee_id(payload.employee_id):
            raise APIError(
                409, "EMPLOYEE_ID_EXISTS", "An account with this employee ID already exists"
            )
        if await self.users.find_by_email(str(payload.email)):
            raise APIError(409, "EMAIL_EXISTS", "An account with this email already exists")

        user = User(
            employee_id=payload.employee_id,
            employee_name=payload.employee_name.strip(),
            email=str(payload.email),
            password_hash=hash_password(payload.password),
            role=payload.role,
        )
        await self.users.create(user)
        await self.db.commit()
        await self.db.refresh(user)
        return user

    async def login(
        self, payload: LoginRequest, *, user_agent: str | None, ip_address: str | None
    ) -> IssuedTokens:
        # The row lock makes the failed-attempt counter correct under concurrent requests.
        user = await self.users.find_by_employee_id_for_update(payload.employee_id)
        if user is None:
            verify_dummy_password(payload.password)
            raise _invalid_credentials()

        now = utc_now()
        if user.locked_until and user.locked_until > now:
            # Same client-facing error as bad credentials to avoid user-ID enumeration.
            verify_dummy_password(payload.password)
            raise _invalid_credentials()
        if user.locked_until and user.locked_until <= now:
            user.no_of_attempts = 0
            user.locked_until = None

        if not user.is_active:
            verify_dummy_password(payload.password)
            raise _invalid_credentials()

        if not verify_password(payload.password, user.password_hash):
            await self._register_failed_attempt(user, now)
            raise _invalid_credentials()

        if user.role != payload.role:
            # Wrong role after a correct password still counts toward lockout.
            await self._register_failed_attempt(user, now)
            raise _invalid_credentials()

        user.no_of_attempts = 0
        user.locked_until = None
        user.last_login_at = now
        refresh_token = generate_refresh_token()
        active_session = await self.sessions.create(
            ActiveSession(
                user_id=user.id,
                refresh_token_hash=hash_refresh_token(refresh_token),
                user_agent=user_agent,
                ip_address=ip_address,
                expires_at=now + timedelta(days=settings.refresh_token_expire_days),
            )
        )
        await self.db.commit()

        return IssuedTokens(
            access_token=create_access_token(
                user_id=user.id, session_id=active_session.id, role=user.role
            ),
            refresh_token=refresh_token,
            user=user,
        )

    async def refresh(self, refresh_token: str, *, user_agent: str | None) -> IssuedTokens:
        token_hash = hash_refresh_token(refresh_token)
        active_session = await self.sessions.find_by_refresh_hash_for_update(token_hash)
        now = utc_now()

        if active_session is None:
            # Reuse of a rotated token: revoke every session for that user.
            reused = await self.sessions.find_by_previous_refresh_hash_for_update(token_hash)
            if reused is not None:
                await self.sessions.revoke_for_user(reused.user_id)
                await self.db.commit()
            raise APIError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired")

        if active_session.is_revoked or active_session.expires_at <= now:
            if not active_session.is_revoked:
                active_session.is_revoked = True
                await self.db.commit()
            raise APIError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired")

        user = await self.users.find_by_id(active_session.user_id)
        if user is None or not user.is_active:
            active_session.is_revoked = True
            await self.db.commit()
            raise APIError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired")

        rotated_refresh_token = generate_refresh_token()
        active_session.previous_refresh_token_hash = active_session.refresh_token_hash
        active_session.refresh_token_hash = hash_refresh_token(rotated_refresh_token)
        active_session.user_agent = user_agent
        await self.db.commit()
        return IssuedTokens(
            access_token=create_access_token(
                user_id=user.id, session_id=active_session.id, role=user.role
            ),
            refresh_token=rotated_refresh_token,
            user=user,
        )

    async def logout(self, session_id: uuid.UUID) -> None:
        active_session = await self.sessions.find_by_id(session_id)
        if active_session is not None:
            active_session.is_revoked = True
            await self.db.commit()

    async def logout_all(self, user_id: uuid.UUID) -> None:
        await self.sessions.revoke_for_user(user_id)
        await self.db.commit()

    async def _register_failed_attempt(self, user: User, now: datetime) -> None:
        user.no_of_attempts += 1
        if user.no_of_attempts >= MAX_LOGIN_ATTEMPTS:
            user.locked_until = now + LOCKOUT_DURATION
        await self.db.commit()
