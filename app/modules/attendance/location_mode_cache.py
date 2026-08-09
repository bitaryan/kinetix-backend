"""In-process cache for org-wide location mode (hot path for every GPS ping)."""

from __future__ import annotations

import threading
import time

from app.models.attendance import LocationMode

# Short TTL so admin mode flips propagate quickly without locking settings on every ping.
_CACHE_TTL_SECONDS = 30.0

_lock = threading.Lock()
_cached_mode: LocationMode | None = None
_cached_at: float = 0.0


def get_cached_location_mode() -> LocationMode | None:
    with _lock:
        if _cached_mode is None:
            return None
        if (time.monotonic() - _cached_at) > _CACHE_TTL_SECONDS:
            return None
        return _cached_mode


def set_cached_location_mode(mode: LocationMode) -> None:
    global _cached_mode, _cached_at
    with _lock:
        _cached_mode = mode
        _cached_at = time.monotonic()


def clear_cached_location_mode() -> None:
    global _cached_mode, _cached_at
    with _lock:
        _cached_mode = None
        _cached_at = 0.0
