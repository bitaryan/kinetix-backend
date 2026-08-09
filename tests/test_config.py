import pytest
from pydantic import ValidationError

from app.core.config import Settings


def _base_kwargs(**overrides):
    data = {
        "database_url": "postgresql+asyncpg://gpss:gpss@localhost:5432/gpss",
        "jwt_secret_key": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    }
    data.update(overrides)
    return data


def test_settings_accepts_comma_separated_cors_origins() -> None:
    settings = Settings(
        **_base_kwargs(backend_cors_origins="http://localhost:3000, https://app.example.com/")
    )

    assert settings.backend_cors_origins == ["http://localhost:3000", "https://app.example.com"]


def test_samesite_none_requires_secure_cookie() -> None:
    with pytest.raises(ValidationError, match="COOKIE_SECURE must be true"):
        Settings(**_base_kwargs(cookie_samesite="none", cookie_secure=False))


def test_production_requires_secure_cookie_and_https_cors() -> None:
    with pytest.raises(ValidationError, match="COOKIE_SECURE must be true"):
        Settings(
            **_base_kwargs(
                app_env="production",
                cookie_secure=False,
                backend_cors_origins="https://app.example.com",
            )
        )

    with pytest.raises(ValidationError, match="https"):
        Settings(
            **_base_kwargs(
                app_env="production",
                cookie_secure=True,
                backend_cors_origins="http://app.example.com",
            )
        )

    with pytest.raises(ValidationError, match="localhost"):
        Settings(
            **_base_kwargs(
                app_env="production",
                cookie_secure=True,
                backend_cors_origins="https://localhost:3000",
            )
        )

    settings = Settings(
        **_base_kwargs(
            app_env="production",
            cookie_secure=True,
            backend_cors_origins="https://app.example.com",
        )
    )
    assert settings.cookie_secure is True
