"""Simple in-process sliding-window rate limiter for auth endpoints."""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

from fastapi import Request

from app.core.config import get_settings
from app.core.errors import APIError


class SlidingWindowRateLimiter:
    def __init__(self) -> None:
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def hit(self, key: str, *, limit: int, window_seconds: float = 60.0) -> None:
        if limit <= 0:
            return
        now = time.monotonic()
        cutoff = now - window_seconds
        with self._lock:
            bucket = self._events[key]
            while bucket and bucket[0] <= cutoff:
                bucket.popleft()
            if len(bucket) >= limit:
                raise APIError(
                    429,
                    "RATE_LIMITED",
                    "Too many requests. Please try again later",
                )
            bucket.append(now)


_limiter = SlidingWindowRateLimiter()


def client_ip(request: Request) -> str:
    """Return the client IP, honoring X-Forwarded-For only from trusted proxies."""
    settings = get_settings()
    peer = request.client.host if request.client else "unknown"
    if peer in settings.trusted_proxy_ips:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip() or peer
    return peer


def enforce_login_rate_limit(request: Request) -> None:
    settings = get_settings()
    _limiter.hit(
        f"login:{client_ip(request)}",
        limit=settings.login_rate_limit_per_minute,
    )


def enforce_refresh_rate_limit(request: Request) -> None:
    settings = get_settings()
    _limiter.hit(
        f"refresh:{client_ip(request)}",
        limit=settings.refresh_rate_limit_per_minute,
    )
