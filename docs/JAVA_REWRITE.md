# GPSS Backend — Complete Java / Spring Boot Rewrite Context

This document is the **behavioral oracle** for rewriting `GPSS_Backend` in Java.
Mobile and web clients already speak this HTTP contract. A rewrite that changes
status codes, JSON keys, cookie attributes, or error `code` strings **breaks production clients**.

**Python source of truth (until cutover):** `app/`
**Acceptance tests to port:** `tests/`
**This branch:** Java migration. Do not silently change API behavior while porting.

---

## 1. Product

Global Power Sales & Service (GPSS) — field workforce API:

- Employees/managers punch in/out with selfie + odometer photos and GPS.
- Continuous GPS trail during a shift (or single-location mode).
- Client visit logs with optional selfie/GPS.
- Leave apply / approve / reject.
- Admin creates users and toggles org-wide location mode.

There is **no live dashboard read API and no WebSocket hub** in Python today.
Do **not** invent those during the first Java parity cut. Parity first; live map later.

---

## 2. Target stack (locked)

| Concern | Choice |
|---|---|
| Language | Java 21 |
| Framework | Spring Boot 3.3+ (servlet, not WebFlux) |
| Build | Gradle (Kotlin DSL) |
| Persistence | Spring Data JPA + Hibernate, PostgreSQL 16 |
| Migrations | Flyway. **Baseline** the existing Alembic schema. Never drop/recreate prod tables. |
| Validation | Bean Validation (`jakarta.validation`) on DTOs |
| Security | Spring Security 6: JWT access + opaque refresh cookie |
| Passwords | Argon2id, must **verify existing** `pwdlib` PHC hashes in `users.password_hash` |
| JSON | Jackson with **explicit `@JsonProperty` per field** (do not enable global snake_case) |
| IDs | `java.util.UUID` ↔ `uuid` columns |
| Time | `OffsetDateTime` / `Instant` UTC. All timestamptz columns. |
| Tests | JUnit 5 + Spring Boot Test + Testcontainers PostgreSQL + MockMvc |
| Package root | `com.gpss.backend` |

**Forbidden**

- Raw SQL in services/controllers (JPQL / Criteria / Spring Data only). Native SQL only inside Flyway.
- Returning `password_hash`, raw refresh tokens in JSON, or logging passwords.
- Changing URL paths or the `{ success, data, error }` envelope.
- BCrypt for new hashes until every existing Argon2 hash has been verified compatible.
- Regenerating the database from JPA `ddl-auto=update` / `create`.

---

## 3. Package layout (feature modules)

Mirror Python `app/modules/<feature>/`.

```text
src/main/java/com/gpss/backend/
  GpssBackendApplication.java
  common/
    api/          ApiResponse, ApiError, ApiException, GlobalExceptionHandler
    web/          SecurityHeadersFilter
  config/         Cors, Jackson (FAIL_ON_UNKNOWN_PROPERTIES=false is OK; do not rename keys)
  security/       JwtService, RefreshCookie, RateLimiter, CurrentPrincipal
  auth/
    api/          AuthController
    application/  AuthService
    domain/       User, ActiveSession, UserRole
    infra/        UserRepository, ActiveSessionRepository
    web/          LoginRequest, UserProfileDto, ...
  attendance/     (same layers)
  clientlog/
  leave/
  upload/
  bootstrap/      CreateAdminCommand (replaces app/scripts/create_admin.py)

src/main/resources/
  application.yml
  db/migration/   Flyway, starting with a baseline of the current Postgres schema
```

Layer rules (same as Python AGENTS.md):

- **Controller:** parse HTTP, call service, map DTO. No business rules.
- **Service:** lockout, overlap, punch rules, GPS accept/reject reasons.
- **Repository:** JPA only.
- **DTOs:** request/response only.

---

## 4. HTTP envelope (mandatory)

Success:

```json
{
  "success": true,
  "data": { },
  "error": null
}
```

Failure:

```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "Invalid user ID or password"
  }
}
```

List endpoints that also send `meta`:

- `GET /api/v1/leaves` — `meta: { total, page, limit }` (no aliases on these three keys)
- `GET /api/v1/client-logs` — `meta: { page, limit, totalCount, totalPages }`

Implement:

```java
public record ApiResponse<T>(boolean success, T data, ApiError error) {
  public static <T> ApiResponse<T> ok(T data) {
    return new ApiResponse<>(true, data, null);
  }
}
public record ApiError(String code, String message) {}
```

`@ControllerAdvice` maps `ApiException(status, code, message)` to that JSON.
Unknown exceptions → `500 INTERNAL_ERROR` / `"An unexpected error occurred"` (never leak stack traces).
Bean Validation → `422 VALIDATION_ERROR` / `"Request data is invalid"` unless a domain message is specified below.

Jackson: serialize with the **exact JSON names in this document**. Mix of camelCase and snake_case is intentional.

---

## 5. Configuration

Map from Python `app/core/config.py` / `.env.example`:

| Env | Default | Notes |
|---|---|---|
| `APP_NAME` | GPSS Backend | |
| `APP_ENV` | development | `production` disables `/docs` equivalent (no springdoc in prod) |
| `API_V1_PREFIX` | `/api/v1` | |
| `DATABASE_URL` | `postgresql+asyncpg://gpss:gpss@localhost:5432/gpss` | Spring: `jdbc:postgresql://localhost:5432/gpss` |
| `JWT_SECRET_KEY` | min 32 chars | Reject placeholders starting with `replace-` |
| `JWT_ALGORITHM` | HS256 | |
| `JWT_ISSUER` | gpss-backend | |
| `JWT_AUDIENCE` | gpss-client | |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | 15 | |
| `REFRESH_TOKEN_EXPIRE_DAYS` | 7 | |
| `COOKIE_SECURE` | false locally; **true in production** | |
| `COOKIE_SAMESITE` | strict | `none` requires Secure |
| `BACKEND_CORS_ORIGINS` | localhost:3000, localhost:5173 | credentials=true; no `*` |
| `LOGIN_RATE_LIMIT_PER_MINUTE` | 120 | per IP |
| `REFRESH_RATE_LIMIT_PER_MINUTE` | 300 | per IP |
| `LOCATION_PING_RATE_LIMIT_PER_MINUTE` | 120 | per user + IP×100 |
| `LOCATION_PING_MIN_INTERVAL_SECONDS` | 5 | |
| `LOCATION_PING_MAX_PER_SESSION` | 6000 | |
| `LOCATION_PING_BATCH_MAX` | 120 | |
| `TRUSTED_PROXY_IPS` | empty | X-Forwarded-For only if peer in this list |
| `DB_POOL_SIZE` / `MAX_OVERFLOW` / timeout | 20 / 40 / 30s | Hikari |
| `UPLOAD_DIR` | uploads | |
| `MAX_UPLOAD_BYTES` | 5242880 | |
| `PUBLIC_BASE_URL` | empty | selfie URLs relative `/uploads/...` if empty |

Production validators (copy from Python): TLS on DB URL, HTTPS CORS origins, no localhost CORS, cookie secure.

---

## 6. Database (reuse — do not reinvent)

PostgreSQL. Column names are **snake_case**. Java fields camelCase with `@Column(name = "...")`.

### 6.1 Enums (Postgres values are authoritative)

| PG type | Values | Java |
|---|---|---|
| `user_role` | `ADMIN`, `MANAGER`, `EMPLOYEE` | enum matching **exactly** |
| `attendance_status` | `punched_in`, `punched_out` | **lowercase with underscore** — not `PUNCHED_IN` |
| `location_mode` | `continuous`, `single` | lowercase |
| `leave_status` | `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED` | uppercase |

Use `@Enumerated(EnumType.STRING)` plus `AttributeConverter` if Hibernate would emit the Java constant name instead of the PG value.

### 6.2 Tables

**users** (`user_id` PK UUID)

- `employee_id` VARCHAR(30) UNIQUE — login identifier, stored **UPPERCASE**
- `employee_name` VARCHAR(100)
- `email` VARCHAR(255) UNIQUE — stored **lowercase**
- `password_hash` VARCHAR(255) Argon2 PHC
- `role` user_role
- `is_active` bool default true
- `no_of_attempts` int default 0
- `locked_until` timestamptz null
- `last_login_at` timestamptz null
- `created_at` / `updated_at` timestamptz

**active_sessions** (`session_id` PK UUID)

- `user_id` FK users ON DELETE CASCADE
- `refresh_token_hash` CHAR/VARCHAR(64) UNIQUE — SHA-256 hex of opaque token
- `previous_refresh_token_hash` VARCHAR(64) UNIQUE NULL — reuse detection
- `user_agent` text, `ip_address` VARCHAR(45)
- `is_revoked` bool
- `expires_at` timestamptz
- `created_at` / `updated_at`

**attendance_sessions** (`session_id` PK)

- `user_id` FK
- `status` attendance_status
- `opening_odo_km` NUMERIC(10,2), `closing_odo_km` nullable
- `opening_selfie_path`, `opening_odo_image_path` VARCHAR(512)
- `closing_odo_image_path` nullable
- punch in/out lat/lng/accuracy
- `punched_in_at`, `punched_out_at`
- **Partial unique index:** one `punched_in` row per `user_id`
  (`uq_attendance_sessions_one_active_per_user`)

**location_pings** (`ping_id` PK)

- `attendance_session_id` FK CASCADE
- lat, lng, accuracy, `captured_at`, battery, speed, `created_at`
- index `(attendance_session_id, captured_at)`

**location_settings** singleton `singleton_key = 'default'`

- `location_mode` default `continuous`

**client_logs**

- `user_id` FK, `client_name`(150), `company_name`(200), `mobile_number`(20), `mail_id`(255)
- `log_date` date, `selfie_path`, lat NUMERIC(10,8), lng NUMERIC(11,8), `location_accuracy`
- `notes` unused in API today

**leaves**

- `user_id`, `start_date`, `end_date`, `reason`, `status`
- `approved_by` FK users SET NULL, `rejection_reason`
- CHECK `end_date >= start_date`

Flyway: `baseline-on-migrate=true` at the current Alembic head. New Java-era changes get `V2026xxxx__*.sql`.

---

## 7. Authentication (port exactly)

### 7.1 JWT access token

- Alg: HS256
- Claims: `sub` = user UUID, `sid` = session UUID, `role` = `ADMIN|MANAGER|EMPLOYEE`
- Also: `iat`, `nbf`, `exp`, `iss`=`gpss-backend`, `aud`=`gpss-client`
- TTL: 15 minutes
- Sent as `Authorization: Bearer <token>`
- Role in JWT is **not** authorization: load user from DB and use `users.role`

Every authenticated request:

1. Missing/non-bearer → `401 UNAUTHORIZED` `"A bearer access token is required"`
2. Bad/expired JWT → `401 UNAUTHORIZED` `"Invalid or expired access token"`
3. Session missing, user_id mismatch, `is_revoked`, or `expires_at <= now` → `401 UNAUTHORIZED` `"Access session is no longer active"`
4. User missing or `is_active=false` → `401 UNAUTHORIZED` `"User account is unavailable"`
5. Role not allowed → `403 FORBIDDEN` `"You do not have permission for this action"`

### 7.2 Refresh cookie

- Name: `refresh_token`
- HttpOnly, Secure from config, SameSite from config
- Path: **`/api/v1/auth`** (not `/`)
- Max-Age: refresh TTL in seconds
- Value: opaque `token_urlsafe(48)`-equivalent (SecureRandom, URL-safe, ~64 chars)
- Stored as SHA-256 hex of UTF-8 bytes

### 7.3 Login `POST /api/v1/auth/login`

JSON:

```json
{ "userId": "EMP001", "password": "...", "role": "EMPLOYEE" }
```

- `userId` → uppercase trim, match `employee_id` (not email)
- Lock user row (`SELECT … FOR UPDATE`)
- Unknown user / locked / inactive / bad password / **wrong role after good password**: same `401 INVALID_CREDENTIALS` `"Invalid user ID or password"`
- Dummy Argon2 verify on unknown user (timing)
- Failed attempt: `no_of_attempts++`; at **≥ 5** set `locked_until = now + 15 minutes`
- Wrong role **counts as a failed attempt**
- Success: reset attempts, `last_login_at=now`, **revoke all other sessions for user**, create one session, set cookie
- Rate limit per IP

Response `200`:

```json
{
  "success": true,
  "data": {
    "accessToken": "...",
    "tokenType": "bearer",
    "expiresIn": 900,
    "user": {
      "id": "<uuid>",
      "userId": "EMP001",
      "employeeName": "...",
      "email": "...",
      "role": "EMPLOYEE",
      "isActive": true,
      "createdAt": "<iso-8601>"
    }
  },
  "error": null
}
```

Never return the refresh token in JSON.

### 7.4 Refresh `POST /api/v1/auth/refresh`

- No bearer required
- Cookie missing → `401 INVALID_REFRESH_TOKEN` `"Refresh token is missing"`
- Lookup current hash `FOR UPDATE`
- If not found, lookup `previous_refresh_token_hash` (reuse): **revoke all sessions for that user**, then same invalid error
- Revoked or expired → `401 INVALID_REFRESH_TOKEN` `"Refresh token is invalid or expired"`
- Rotate: move current hash to `previous_refresh_token_hash`, new hash, bump `expires_at`, new access JWT
- Set-Cookie with new refresh token

### 7.5 Other auth

| Method | Path | Auth | Behavior |
|---|---|---|---|
| POST | `/api/v1/auth/logout` | Bearer | revoke this session, clear cookie. Message: `Successfully logged out` |
| POST | `/api/v1/auth/logout-all` | Bearer | revoke all user sessions, clear cookie. `Successfully logged out from all devices` |
| GET | `/api/v1/auth/me` | Bearer | `UserProfile` as in login |
| POST | `/api/v1/auth/users` | ADMIN | create user. Admin role via API is **forbidden** (`403 FORBIDDEN` bootstrap-only). Duplicate employee_id `409 EMPLOYEE_ID_EXISTS`. Duplicate email `409 EMAIL_EXISTS`. Password min 12, upper+lower+digit |

Create-user body aliases: `userId`, `employeeName`, `email`, `password`, `role` (default EMPLOYEE). `201` + UserProfile.

CLI: `CreateAdminCommand` with `allowAdminRole=true` (Python `python -m app.scripts.create_admin`).

Password create rules: login min 8; create-user min 12 + complexity.

---

## 8. Attendance

Roles: **EMPLOYEE, MANAGER** only (not ADMIN) for punch/ping. ADMIN only for location-settings.

### 8.1 Punch-in `POST /api/v1/attendance/punch-in` `201`

`multipart/form-data`:

| Field | Required | Notes |
|---|---|---|
| `selfie` | yes | JPEG/PNG/WebP, magic-bytes, ≤ 5 MiB |
| `openingOdoImage` | yes | same |
| `openingOdoKm` | yes | Decimal ≥ 0, ≤ 9999999.99, 2 dp |
| `latitude` | yes | -90..90 |
| `longitude` | yes | -180..180 |
| `accuracy` | no | ≥ 0 |
| `capturedAt` | no | ISO-8601 **with offset**; naive → 422 |

Rules:

- Lock user row, then lock/find active session. If active → `409 ALREADY_PUNCHED_IN`
- Unique partial index also causes IntegrityError → same 409
- `capturedAt` skew vs server > **24 hours** → `400 STALE_TIMESTAMP`
- Missing tz on capturedAt → `422 VALIDATION_ERROR` `"capturedAt must include a timezone offset"`
- Persist images then DB; on failure delete files
- Write first `location_pings` row
- Paths: `attendance/{userId}/{sessionId}/selfie.jpg` and `opening_odo.{ext}`

Response `data` (camelCase):

`sessionId`, `status` (`punched_in`), `punchedInAt`, `punchedOutAt`, `openingOdoKm`, `closingOdoKm`, `latitude`, `longitude` (punch-in coords), `locationMode`

### 8.2 Current `GET /api/v1/attendance/current`

```json
{
  "punchedIn": false,
  "session": null,
  "locationMode": "continuous"
}
```

If punched in, `session` is the punch-in session DTO above.

### 8.3 Location ping `POST /api/v1/attendance/location-ping`

JSON aliases: `sessionId`, `latitude`, `longitude`, `accuracy`, `capturedAt`, `battery` (0–100), `speed` ≥ 0.

**Always HTTP 200** for business rejects (`accepted: false`). Do not use 4xx for GPS business rules.

Reasons:

| reason | When |
|---|---|
| `SESSION_NOT_FOUND` | unknown session or not owned by caller |
| `SESSION_NOT_ACTIVE` | not `punched_in` |
| `SINGLE_LOCATION_MODE` | org mode `single` |
| `SESSION_TRAIL_FULL` | ping count ≥ 6000 |
| `INVALID_TIMESTAMP` | naive / missing tz `capturedAt` |
| `STALE_PING` | \|captured_at − now\| > 24h |
| `TOO_FREQUENT` | gap since last ping `captured_at` < 5s |

Success: `{ accepted, reason, pingId, locationMode }`

Hot path today: lock session row, COUNT pings, latest captured_at, insert. Port that behavior for parity (optimize later).

Rate limit: cost=1 per user and per IP (IP limit = user limit × 100). `429 RATE_LIMITED` `"Too many requests. Please try again later"`

### 8.4 Batch `POST /api/v1/attendance/location-pings`

```json
{ "sessionId": "...", "pings": [ { "latitude", "longitude", "accuracy", "capturedAt", "battery", "speed" } ] }
```

- `pings` length 1..`LOCATION_PING_BATCH_MAX` (120)
- Sort by `capturedAt` for interval checks
- Rate-limit **cost = pings.size()**
- Response: `acceptedCount`, `rejectedCount`, `locationMode`, `items: [{ index, accepted, reason, pingId }]`

### 8.5 Punch-out `POST /api/v1/attendance/punch-out`

Multipart: `closingOdoImage`, `closingOdoKm`, `latitude`, `longitude`, `accuracy?`, `capturedAt?`

- No active session → `409 NOT_PUNCHED_IN`
- `closingOdoKm < openingOdoKm` → `400 INVALID_ODO_READING`
- If continuous and trail not full, append a final ping
- Status `punched_out`

### 8.6 Admin location settings

- `GET/PATCH /api/v1/admin/location-settings` ADMIN only
- Body `{ "locationMode": "continuous" | "single" }`
- In-process 30s cache in Python — Redis optional; 30s TTL cache is enough for parity

### 8.7 Images

Magic bytes: JPEG `FF D8 FF`, PNG `\x89PNG\r\n\x1a\n`, WebP `RIFF....WEBP`.
Content-Type allow-list must still match. Empty file / spoofed MIME → `400 INVALID_IMAGE`. Oversize → `400 IMAGE_TOO_LARGE`.

---

## 9. Client logs

Roles: create/list **EMPLOYEE, MANAGER**. Delete **MANAGER, ADMIN**. Admin cannot create (not in `_FieldStaff`).

### List `GET /api/v1/client-logs`

Query: `page` ≥1, `limit` 1–100 default 20, `search` max 80.

**Scoped to caller only** (even managers). Search client_name / company_name / mobile_number.

`date` in items is `DD/MM/YYYY`. Aliases: `userId`, `clientName`, `companyName`, `mobileNumber`, `mailId`, `selfieUrl`, `locationAccuracy`, `createdAt`.

### Create `POST /api/v1/client-logs` `201`

Multipart fields: `client_name`, `company_name`, `mobile_number`, `mail_id`, `date`, `selfie?`, `latitude?`, `longitude?`, `accuracy?`

- Mobile: exactly 10 digits
- Email valid, stored lowercase
- Names min 2 after trim
- `date`: `DD/MM/YYYY` or ISO `YYYY-MM-DD`
- lat/lng **both or neither** else 422 `"latitude and longitude must be provided together"`
- Selfie JPEG/PNG only (client-log storage is stricter than attendance — **no WebP** in Python client_log storage; match that)
- Path: `client_logs/{year}/{month}/{userId}/{logId}.ext`

### Delete `DELETE /api/v1/client-logs/{id}`

Manager: own logs only (else 404). Admin: any. Message: `Client log deleted successfully`. Always `404 NOT_FOUND` `"Client log not found"` for IDOR (no 403).

---

## 10. Leaves

All staff can list/get/apply. Status patch: MANAGER, ADMIN.

**JSON key quirk:** leave list/detail/create dates and several fields are **snake_case** (`start_date`, `end_date`, `created_at`, `user_id`, `applicant_name`, `rejection_reason`, `approved_by`, `updated_at`). Status in JSON is **title case**: `Pending`, `Approved`, `Rejected`, `Cancelled`. Dates in JSON: **`DD/MM/YY`**.

Accept input dates: `DD/MM/YY`, `DD/MM/YYYY`, ISO `YYYY-MM-DD`. YY → 2000–2099.

### List `GET /api/v1/leaves`

- Employee: own only. Manager/Admin: all.
- `status` filter: PENDING/APPROVED/REJECTED. `CANCELLED` → 422.
- Envelope includes `meta: { total, page, limit }`

### Apply `POST /api/v1/leaves` `201`

Body: `{ "start_date", "end_date", "reason" }` (reason default `""`, max 500).

- end < start → `422 INVALID_DATE_RANGE` `"End date cannot be earlier than start date."`
- Overlap with existing PENDING or APPROVED for same user → `409 LEAVE_OVERLAP`
- Lock user row before overlap check
- Message: `Leave application submitted successfully`

Overlap: `start_date <= newEnd AND end_date >= newStart`.

### Get `GET /api/v1/leaves/{id}`

Employee accessing another user's leave → `404 NOT_FOUND` (no leak).

### Patch status `PATCH /api/v1/leaves/{id}/status`

Body: `{ "status": "APPROVED"|"REJECTED", "rejection_reason": "..." }`

- Reject requires non-empty rejection_reason
- Approve requires rejection_reason null
- Cannot act on own leave → 403
- Not PENDING → `409 INVALID_LEAVE_STATE`
- Message: `Leave application status updated to APPROVED` (enum value, not title case)

---

## 11. Uploads and health

`GET /uploads/{path}` — **authenticated**. Employee: only if path owner matches (layouts in `uploads.py`). Manager/Admin: any file under upload root. Path traversal → 404. Do not serve outside `UPLOAD_DIR`.

`GET /health`

- DB ping OK: `200` `{"success":true,"data":{"status":"ok"},"error":null}`
- DB down: `503` `SERVICE_UNAVAILABLE` `"Database is unavailable"`

Disable Swagger in production (`APP_ENV=production`).

CORS: methods GET POST PUT PATCH DELETE OPTIONS; headers Authorization, Content-Type; credentials true.

Security headers: port `SecurityHeadersMiddleware` (read `app/core/security_headers.py` and match).

---

## 12. Error code catalog

| HTTP | code | Typical message |
|---|---|---|
| 401 | INVALID_CREDENTIALS | Invalid user ID or password |
| 401 | UNAUTHORIZED | (several; copy exact strings above) |
| 401 | INVALID_REFRESH_TOKEN | missing / invalid or expired |
| 403 | FORBIDDEN | permission / admin bootstrap / self-approve |
| 404 | NOT_FOUND | leave / client log / file |
| 409 | EMPLOYEE_ID_EXISTS | |
| 409 | EMAIL_EXISTS | |
| 409 | ALREADY_PUNCHED_IN | |
| 409 | NOT_PUNCHED_IN | |
| 409 | LEAVE_OVERLAP | |
| 409 | INVALID_LEAVE_STATE | |
| 400 | STALE_TIMESTAMP | |
| 400 | INVALID_ODO_READING | |
| 400 | INVALID_IMAGE | |
| 400 | IMAGE_TOO_LARGE | |
| 422 | VALIDATION_ERROR | |
| 422 | INVALID_DATE_RANGE | |
| 429 | RATE_LIMITED | |
| 500 | INTERNAL_ERROR | |
| 503 | SERVICE_UNAVAILABLE | |

GPS soft-fail reasons are **not** HTTP error codes; they live in `data.reason`.

---

## 13. Rate limiting

Python is in-process sliding 60s window. For Java:

- Parity: Bucket4j in-memory is OK for single instance.
- Multi-instance: Redis later. Do not require Redis for v1 parity.

Keys: `login:{ip}`, `refresh:{ip}`, `locping:user:{id}`, `locping:ip:{ip}`.

---

## 14. Implementation sequence (do in this order)

1. Gradle + Spring Boot app, envelope, exception handler, CORS, security headers, health.
2. Flyway baseline against existing Postgres.
3. JPA entities matching column names/enums.
4. **Auth** (login, cookie, refresh reuse, lockout, create user, `/me`). Port `tests/test_auth_contract.py` and `tests/test_api_auth_flows.py` to MockMvc.
5. Leaves → client logs + uploads → attendance.
6. Rate limits and production config validators.
7. `CreateAdminCommand`.
8. Only after HTTP parity: live-tracking upgrades (`clientEventId`, last-known, WebSocket). Spec: conversation audit; not in Python today.

Do not delete `app/` until MockMvc (or a recorded HTTP suite) matches Python tests.

---

## 15. Test porting map

| Python | Java focus |
|---|---|
| `tests/test_auth_contract.py` | cookie path, JWT claims, lockout, enumeration |
| `tests/test_api_auth_flows.py` | refresh rotation, reuse, logout |
| `tests/test_attendance_flow.py` | punch, ping soft-fail, batch, single mode, trail full |
| `tests/test_client_log_flow.py` | multipart, search, delete IDOR |
| `tests/test_leave_flow.py` | date formats, overlap, self-approve, title-case status |
| `tests/test_uploads_and_health.py` | authz on `/uploads`, health 503 |
| `tests/test_security_vulnerabilities.py` | IDOR, JWT tamper — must still pass |

Use Testcontainers PostgreSQL. Do not hit a shared dev DB.

---

## 16. Python files to read while coding each module

| Java module | Read first |
|---|---|
| auth | `app/modules/auth/service.py`, `dependencies.py`, `endpoints/auth.py`, `core/security.py` |
| attendance | `app/modules/attendance/service.py`, `schemas.py`, `endpoints/attendance.py` |
| clientlog | `app/modules/client_log/service.py`, `endpoints/client_logs.py`, `storage.py` |
| leave | `app/modules/leave/service.py`, `schemas.py`, `endpoints/leaves.py` |
| upload | `app/api/v1/endpoints/uploads.py` |
| config | `app/core/config.py`, `.env.example` |

---

## 17. Definition of done (parity)

- Same paths, methods, status codes, error codes, cookie name/path/flags.
- Existing Argon2 hashes in Postgres still log in.
- Flutter/web clients work against Java with **no client change**.
- `GET /health` and all `/api/v1/*` routes from `CODE_REVIEW_GUIDE.md` section 7 exist.
- No `ddl-auto` schema drift vs Flyway.
