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

Shift boundaries are the server's `punchedInAt`/`punchedOutAt`, not the optional
GPS timestamp submitted with a photo. Older in-shift samples are checked against
both neighboring stored timestamps: a gap smaller than the configured minimum
(5 seconds by default) is `TOO_FREQUENT`. An exact 5-second gap is allowed. The
24-hour freshness, accuracy, mode and trail-capacity checks still apply.
An accepted historical sample increases the trail count without moving the
dashboard's newest position backward. This also works during an active shift.

Both single and batch retries of a stored `clientEventId` return `DUPLICATE`,
including after the organization switches to single-location mode. Duplicates
are counted as accepted and never insert another row.

## Rate limits

The default is an in-memory sliding window for one Node.js process. Set
`REDIS_URL` and `REDIS_KEY_PREFIX` to share the sliding window across replicas.

- Login: per IP
- Refresh: per IP
- Location: **1 token per HTTP request** on the user bucket (a 120-point `location-pings` flush costs 1, so it cannot starve the next live `location-ping`). IP bucket = 100× the per-user limit.

The Redis implementation atomically checks the user and IP buckets and charges
one request only when both have capacity. Redis connection failures return an
HTTP 503 envelope; retry with the same event IDs. All replicas must use the same
Redis prefix and database. Do not enable multiple processes without shared limits.

## Dashboard

`GET /api/v1/admin/live-locations` — latest `last_known_*` for every `punched_in` session. Presence: `live` ≤ 2 min, `stale` ≤ 15 min, else `offline` (from `last_known_captured_at`).

Browser WebSocket upgrades must use an origin on `BACKEND_CORS_ORIGINS`. Tokens,
active sessions and current roles are revalidated before sending queued live
updates and every 30 seconds while idle. On expiry, refresh the access token
and reconnect with the new token in STOMP `CONNECT`; revoked users must sign in
again. Phones continue using HTTP only.

Redis pub/sub forwards committed events between API instances. It is a transient
feed, not a replay log: reload the REST snapshot after connecting/reconnecting
and periodically while viewing the dashboard to recover missed events and age
presence without new GPS pings. Remove entries on `status: punched_out`. If events
arrive out of order, retain the newest `capturedAt` for each session; a punch-out
still closes that session even when its GPS timestamp is unchanged.
