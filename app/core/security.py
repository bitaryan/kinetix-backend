import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt
from jwt import InvalidTokenError
from pwdlib import PasswordHash

from app.core.config import get_settings
from app.core.errors import APIError
from app.models.user import UserRole

settings = get_settings()
password_hash = PasswordHash.recommended()
# Used when no user is found so password checks do not reveal user existence by timing.
DUMMY_PASSWORD_HASH = password_hash.hash("not-a-real-password")


@dataclass(frozen=True, slots=True)
class AccessTokenClaims:
    user_id: uuid.UUID
    session_id: uuid.UUID
    role: UserRole


def utc_now() -> datetime:
    return datetime.now(UTC)


def hash_password(password: str) -> str:
    return password_hash.hash(password)


def verify_password(password: str, hashed_password: str) -> bool:
    return password_hash.verify(password, hashed_password)


def verify_dummy_password(password: str) -> None:
    password_hash.verify(password, DUMMY_PASSWORD_HASH)


def create_access_token(*, user_id: uuid.UUID, session_id: uuid.UUID, role: UserRole) -> str:
    now = utc_now()
    payload = {
        "sub": str(user_id),
        "sid": str(session_id),
        "role": role.value,
        "iat": now,
        "nbf": now,
        "exp": now + timedelta(minutes=settings.access_token_expire_minutes),
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> AccessTokenClaims:
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret_key,
            algorithms=[settings.jwt_algorithm],
            issuer=settings.jwt_issuer,
            audience=settings.jwt_audience,
        )
        return AccessTokenClaims(
            user_id=uuid.UUID(payload["sub"]),
            session_id=uuid.UUID(payload["sid"]),
            role=UserRole(payload["role"]),
        )
    except (InvalidTokenError, KeyError, ValueError) as exc:
        raise APIError(401, "UNAUTHORIZED", "Invalid or expired access token") from exc


def generate_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_refresh_token(token: str) -> str:
    """Hash a high-entropy opaque refresh token before persistence."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
