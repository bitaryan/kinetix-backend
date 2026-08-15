# Native GPS client guidance (GPSS)

Phones **must not** open the dashboard WebSocket. Only manager/admin browsers subscribe to STOMP at `/ws` → `/topic/live-locations`. Employees send HTTP pings.

## Access token

Access JWTs expire in **15 minutes**. Refresh with `POST /api/v1/auth/refresh` and the HttpOnly `refresh_token` cookie (`Path=/api/v1/auth`) in the native HTTP stack — not in a JS timer. Do not assume a WebView timer survives Doze, App Standby, or force-quit.

## Android

Use a **Foreground Service** with a **persistent notification** while punched in. Request location in the background (`ACCESS_FINE_LOCATION` + background location on Android 10+). JS `setInterval` will be frozen in Doze; the OS will kill the process after force-quit.

Queue samples in **local SQLite**. Each row needs a `clientEventId` (UUID v4, unique per attendance session). Retry the same id on network failure — the server returns `accepted: true` with `reason: DUPLICATE` and does not insert a second row.

## iOS

Enable **Location updates** background mode and keep a `CLLocationManager` with `allowsBackgroundLocationUpdates`. Use **Significant Location Change** as a fallback when the full-accuracy session is suspended. Local SQLite + `clientEventId` is the same as Android.

## Ingest contract (additive)

Existing fields still work: `sessionId`, `latitude`, `longitude`, `accuracy`, `capturedAt` (ISO-8601 **with offset**), `battery`, `speed`.

Optional:

- `clientEventId` — UUID, unique per session
- `isMock` — boolean

Soft-fail reasons stay HTTP **200** with `data.accepted = false`:

`SESSION_NOT_FOUND`, `SESSION_NOT_ACTIVE`, `SINGLE_LOCATION_MODE`, `SESSION_TRAIL_FULL`, `INVALID_TIMESTAMP`, `STALE_PING` (24h vs server), `TOO_FREQUENT`, `LOW_ACCURACY` (accuracy worse than 100m, configurable).

After punch-out, a queued point is still accepted if `capturedAt` is between punch-in and punch-out (offline flush). A sample captured after punch-out is `SESSION_NOT_ACTIVE`.

## Rate limits (single instance)

In-memory sliding window (not shared across JVM instances).

- Login: per IP
- Refresh: per IP
- Location: **1 token per HTTP request** on the user bucket (a 120-point `location-pings` flush costs 1, so it cannot starve the next live `location-ping`). IP bucket = 100× the per-user limit.

Multi-instance production should replace `RateLimiter` with Redis; the hub is an in-memory STOMP broker and can later publish via Redis pub/sub.

## Dashboard

`GET /api/v1/admin/live-locations` — latest `last_known_*` for every `punched_in` session. Presence: `live` ≤ 2 min, `stale` ≤ 15 min, else `offline` (from `last_known_captured_at`).
