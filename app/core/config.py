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
    # Defaults sized so ~100 staff can authenticate from a shared NAT without collapse.
    login_rate_limit_per_minute: int = Field(default=120, ge=0)
    refresh_rate_limit_per_minute: int = Field(default=300, ge=0)
    # Per-user GPS trail throttle (continuous mode typically sends every 30–60s).
    location_ping_rate_limit_per_minute: int = Field(default=120, ge=0)
    # Drop near-duplicate GPS samples closer than this (seconds) to protect DB under bursty clients.
    location_ping_min_interval_seconds: float = Field(default=5.0, ge=0, le=300)
    # Hard cap per punch session (~8h at 5s interval ≈ 5760; buffer for catch-up).
    location_ping_max_per_session: int = Field(default=6000, ge=1, le=50000)
    # Max queued offline pings the client may flush in one batch request.
    location_ping_batch_max: int = Field(default=120, ge=1, le=500)
    # Comma-separated reverse-proxy IPs trusted for X-Forwarded-For (empty = ignore headers).
    trusted_proxy_ips: Annotated[list[str], NoDecode] = []

    # Async SQLAlchemy pool sized for concurrent punch + location traffic (~100 users).
    db_pool_size: int = Field(default=20, ge=5, le=100)
    db_max_overflow: int = Field(default=40, ge=0, le=100)
    db_pool_timeout_seconds: int = Field(default=30, ge=5, le=120)

    # Local disk path for punch-in / punch-out verification images.
    upload_dir: str = "uploads"
    # Max bytes accepted for a single verification image upload.
    max_upload_bytes: int = Field(default=5 * 1024 * 1024, ge=1024)

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
