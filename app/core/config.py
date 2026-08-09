from functools import lru_cache
from typing import Annotated, Literal, Self
from urllib.parse import urlparse

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    """Validated configuration loaded from environment variables and `.env`."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "GPSS Backend"
    app_env: Literal["development", "test", "production"] = "development"
    api_v1_prefix: str = "/api/v1"
    database_url: str

    jwt_secret_key: str = Field(min_length=32)
    jwt_algorithm: Literal["HS256"] = "HS256"
    jwt_issuer: str = "gpss-backend"
    jwt_audience: str = "gpss-client"
    access_token_expire_minutes: int = Field(default=15, ge=1, le=60)
    refresh_token_expire_days: int = Field(default=7, ge=1, le=30)

    cookie_secure: bool = False
    cookie_samesite: Literal["lax", "strict", "none"] = "strict"
    backend_cors_origins: Annotated[list[str], NoDecode] = ["http://localhost:3000"]

    # Per-IP sliding window. Set to 0 to disable (tests may raise this).
    login_rate_limit_per_minute: int = Field(default=20, ge=0)
    refresh_rate_limit_per_minute: int = Field(default=60, ge=0)
    # Comma-separated reverse-proxy IPs trusted for X-Forwarded-For (empty = ignore headers).
    trusted_proxy_ips: Annotated[list[str], NoDecode] = []

    @field_validator("backend_cors_origins", "trusted_proxy_ips", mode="before")
    @classmethod
    def split_csv_list(cls, value: str | list[str]) -> list[str]:
        if isinstance(value, str):
            return [item.strip().rstrip("/") for item in value.split(",") if item.strip()]
        return value

    @model_validator(mode="after")
    def validate_security_settings(self) -> Self:
        if self.cookie_samesite == "none" and not self.cookie_secure:
            raise ValueError("COOKIE_SECURE must be true when COOKIE_SAMESITE is none")

        if self.app_env == "production":
            if not self.cookie_secure:
                raise ValueError("COOKIE_SECURE must be true when APP_ENV is production")
            if not self.backend_cors_origins:
                raise ValueError("BACKEND_CORS_ORIGINS must be set when APP_ENV is production")
            for origin in self.backend_cors_origins:
                if origin == "*":
                    raise ValueError(
                        "BACKEND_CORS_ORIGINS must not include * with cookies"
                    )
                parsed = urlparse(origin)
                if parsed.scheme != "https":
                    raise ValueError(
                        "BACKEND_CORS_ORIGINS must use https when APP_ENV is production"
                    )
                host = (parsed.hostname or "").lower()
                if host in {"localhost", "127.0.0.1", "::1"}:
                    raise ValueError(
                        "BACKEND_CORS_ORIGINS must not use localhost in production"
                    )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
