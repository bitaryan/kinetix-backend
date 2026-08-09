"""Simple in-process sliding-window rate limiter for auth and attendance endpoints."""

from __future__ import annotations

import threading
import time
import uuid
from collections import defaultdict, deque

from fastapi import Request

from app.core.config import get_settings
from app.core.errors import APIError


class SlidingWindowRateLimiter:
    def __init__(self) -> None:
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()
        self._last_cleanup = time.monotonic()

    def hit(self, key: str, *, limit: int, window_seconds: float = 60.0, cost: int = 1) -> None:
        if limit <= 0 or cost <= 0:
            return
        now = time.monotonic()
        cutoff = now - window_seconds
        with self._lock:
            self._maybe_cleanup_locked(now=now, window_seconds=window_seconds)
            bucket = self._events[key]
            while bucket and bucket[0] <= cutoff:
                bucket.popleft()
            if len(bucket) + cost > limit:
                raise APIError(
                    429,
                    "RATE_LIMITED",
                    "Too many requests. Please try again later",
                )
            for _ in range(cost):
                bucket.append(now)

    def _maybe_cleanup_locked(self, *, now: float, window_seconds: float) -> None:
        """Drop idle keys so an 8-hour shift does not grow unbounded memory."""
        if now - self._last_cleanup < 300.0:
            return
        self._last_cleanup = now
        cutoff = now - window_seconds
        empty_keys = [
            key
            for key, bucket in self._events.items()
            if not bucket or bucket[-1] <= cutoff
        ]
        for key in empty_keys:
            del self._events[key]


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


def enforce_location_ping_rate_limit(
    request: Request, *, user_id: uuid.UUID, cost: int = 1
) -> None:
    """Throttle GPS trail writes per user (cost scales for offline batch flushes)."""
    settings = get_settings()
    limit = settings.location_ping_rate_limit_per_minute
    _limiter.hit(f"locping:user:{user_id}", limit=limit, cost=cost)
    # Shared-NAT safety: allow up to 100 users * per-user budget.
    _limiter.hit(
        f"locping:ip:{client_ip(request)}",
        limit=max(limit * 100, limit),
        cost=cost,
    )
