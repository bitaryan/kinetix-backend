from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response, status

from app.core.config import get_settings
from app.core.errors import APIError
from app.core.rate_limit import client_ip, enforce_login_rate_limit, enforce_refresh_rate_limit
from app.models.user import UserRole
from app.modules.auth.dependencies import (
    CurrentPrincipal,
    DbSession,
    get_current_principal,
    require_roles,
)
from app.modules.auth.schemas import (
    AccessTokenData,
    CreateUserRequest,
    LoginData,
    LoginRequest,
    MessageData,
    SuccessResponse,
    UserProfile,
)
from app.modules.auth.service import AuthService, IssuedTokens

router = APIRouter(prefix="/auth", tags=["Authentication"])
settings = get_settings()
REFRESH_COOKIE_NAME = "refresh_token"


def _set_refresh_cookie(response: Response, refresh_token: str) -> None:
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=refresh_token,
        max_age=settings.refresh_token_expire_days * 24 * 60 * 60,
        httponly=True,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
        path=f"{settings.api_v1_prefix}/auth",
    )


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(
        key=REFRESH_COOKIE_NAME,
        httponly=True,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
        path=f"{settings.api_v1_prefix}/auth",
    )


def _login_data(issued: IssuedTokens) -> LoginData:
    return LoginData(
        access_token=issued.access_token,
        expires_in=settings.access_token_expire_minutes * 60,
        user=UserProfile.model_validate(issued.user),
    )


@router.post("/login", response_model=SuccessResponse[LoginData])
async def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: DbSession,
) -> SuccessResponse[LoginData]:
    """Authenticate with JSON credentials and issue an access/refresh-token pair."""
    enforce_login_rate_limit(request)
    issued = await AuthService(db).login(
        payload,
        user_agent=request.headers.get("user-agent"),
        ip_address=client_ip(request),
    )
    _set_refresh_cookie(response, issued.refresh_token)
    return SuccessResponse(data=_login_data(issued))


@router.post("/refresh", response_model=SuccessResponse[AccessTokenData])
async def refresh_access_token(
    request: Request,
    response: Response,
    db: DbSession,
) -> SuccessResponse[AccessTokenData]:
    """Rotate the HttpOnly refresh token and issue a fresh short-lived access token."""
    enforce_refresh_rate_limit(request)
    refresh_token = request.cookies.get(REFRESH_COOKIE_NAME)
    if not refresh_token:
        raise APIError(401, "INVALID_REFRESH_TOKEN", "Refresh token is missing")

    issued = await AuthService(db).refresh(
        refresh_token, user_agent=request.headers.get("user-agent")
    )
    _set_refresh_cookie(response, issued.refresh_token)
    return SuccessResponse(
        data=AccessTokenData(
            access_token=issued.access_token,
            expires_in=settings.access_token_expire_minutes * 60,
        )
    )


@router.post("/logout", response_model=SuccessResponse[MessageData])
async def logout(
    response: Response,
    db: DbSession,
    principal: Annotated[CurrentPrincipal, Depends(get_current_principal)],
) -> SuccessResponse[MessageData]:
    """Revoke the current session and remove its refresh-token cookie."""
    await AuthService(db).logout(principal.session_id)
    _clear_refresh_cookie(response)
    return SuccessResponse(data=MessageData(message="Successfully logged out"))


@router.post("/logout-all", response_model=SuccessResponse[MessageData])
async def logout_all(
    response: Response,
    db: DbSession,
    principal: Annotated[CurrentPrincipal, Depends(get_current_principal)],
) -> SuccessResponse[MessageData]:
    """Revoke every session belonging to the current user."""
    await AuthService(db).logout_all(principal.user.id)
    _clear_refresh_cookie(response)
    return SuccessResponse(data=MessageData(message="Successfully logged out from all devices"))


@router.get("/me", response_model=SuccessResponse[UserProfile])
async def get_me(
    principal: Annotated[CurrentPrincipal, Depends(get_current_principal)],
) -> SuccessResponse[UserProfile]:
    return SuccessResponse(data=UserProfile.model_validate(principal.user))


@router.post(
    "/users",
    status_code=status.HTTP_201_CREATED,
    response_model=SuccessResponse[UserProfile],
)
async def create_user(
    payload: CreateUserRequest,
    db: DbSession,
    _: Annotated[CurrentPrincipal, Depends(require_roles(UserRole.ADMIN))],
) -> SuccessResponse[UserProfile]:
    """Create a workforce account. This action is restricted to administrators."""
    user = await AuthService(db).create_user(payload)
    return SuccessResponse(data=UserProfile.model_validate(user))
