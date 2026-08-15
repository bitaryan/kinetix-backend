# Java vs Python discrepancies (intentional)

Python tests remain the oracle for existing routes. These Java-only behaviors are additive or documented upgrades:

1. **Offline flush after punch-out** — Python rejects every ping on a `punched_out` session as `SESSION_NOT_ACTIVE`. Java accepts a sample when `capturedAt` is within `[punched_in_at, punched_out_at]`. A ping with `capturedAt` after punch-out still returns `SESSION_NOT_ACTIVE` (existing tests).
2. **Trail cap** — Python `COUNT(*)` on every ping. Java uses denormalized `attendance_sessions.ping_count` / `last_known_*` (Flyway `V2`).
3. **Batch rate limit** — Python charges `cost = len(pings)`. Java charges **1 token per HTTP request** so a 120-point flush cannot starve the next live ping. See `docs/GPS_CLIENT.md`.
4. **Optional ingest fields** — `clientEventId`, `isMock`, `LOW_ACCURACY` (default 100m). Omitted by old apps.
5. **Dashboard** — `GET /api/v1/admin/live-locations` and STOMP `/topic/live-locations` did not exist in Python.
6. **STALE_PING** remains 24 hours for the original `capturedAt` field.
