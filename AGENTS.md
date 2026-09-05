# AGENTS.md — GPSS Backend

Node.js + Express + Prisma API. Do not change HTTP contracts to look more
"Express-like".

**Read first:** [`docs/JAVA_REWRITE.md`](docs/JAVA_REWRITE.md). The historical
filename is retained for compatibility; its paths, JSON keys, status/error
codes, soft GPS failures, and cookie attributes are the language-neutral API
contract. `docs/GPS_CLIENT.md` documents the additive V2 GPS/live behavior.

## 1. Stack

- JavaScript ESM on Node.js 20.19+ (use an even-numbered LTS in production)
- Express 5, PostgreSQL 16, Prisma ORM
- PostgreSQL migrations in `prisma/migrations`; never use `db push` in production
- Argon2id password hashes; existing PHC strings must continue to verify
- JWT access token plus opaque refresh token in the HttpOnly `refresh_token`
  cookie, scoped to `/api/v1/auth`
- Roles: `ADMIN`, `MANAGER`, `EMPLOYEE` (native DB enum `user_role`)
- Node test runner + Supertest; database suites require an explicit isolated
  `TEST_DATABASE_URL`

## 2. Architecture

Feature directories are `auth`, `attendance`, `clientlog`, `leave`, `upload`,
and `live`.

- Routers parse HTTP input and map responses only.
- Services own business rules, transactions, lockout, overlap, punch, and GPS
  decisions.
- Prisma is the only application persistence API. Raw SQL belongs only in
  migration files.
- Shared envelopes/errors/validation live under `src/common`.
- Authentication and rate limiting live under `src/security`.

Do not put business rules into route registration or persistence helpers.

## 3. Database

- Database columns remain `snake_case`; Prisma fields use camelCase with `@map`.
- Primary keys have existing names such as `user_id`, `session_id`, `ping_id`.
- Native enum values are authoritative:
  - attendance: `punched_in`, `punched_out`
  - location mode: `continuous`, `single`
  - leave: `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`
- Preserve the leave CHECK constraint and both partial unique indexes from the
  custom baseline migration.
- Use serializable interactive transactions with bounded P2034 retries when a
  flow previously relied on pessimistic row locks.
- Never run destructive migration commands against an existing environment.

## 4. Authentication and security

- Login identifier is uppercase employee ID (`userId`), never email.
- Failed password or wrong role increments `no_of_attempts`; at five attempts,
  lock for 15 minutes.
- Unknown user, inactive user, lockout, wrong password, and wrong role share
  `401 INVALID_CREDENTIALS / "Invalid user ID or password"`.
- Login revokes older sessions. Refresh rotates the token; reuse of the previous
  token revokes all sessions for that user.
- Every Bearer request reloads and validates the active session and user. JWT
  role claims are never the source of authorization.
- Never log or return passwords, password hashes, or raw refresh tokens.
- Employees may only read their own files under `/uploads/**`; prevent traversal
  and symlink escapes with real-path containment checks.
- Keep the explicit CORS allow-list and exact security headers.

## 5. HTTP contract

Success:

```json
{"success":true,"data":{},"error":null}
```

Failure:

```json
{"success":false,"data":null,"error":{"code":"INVALID_CREDENTIALS","message":"Invalid user ID or password"}}
```

- Leaves and client-log lists include their distinct exact `meta` shapes.
- The API deliberately mixes camelCase and snake_case by endpoint.
- Leave output dates use `DD/MM/YY` and title-case statuses.
- GPS business failures return HTTP 200 with `data.accepted=false`; preserve all
  documented reasons plus V2 `LOW_ACCURACY` and idempotent `DUPLICATE` behavior.
- Do not change paths, methods, status codes, codes, messages, JSON keys, or
  refresh-cookie attributes without a coordinated client release.

## 6. Images and live tracking

- Validate declared MIME plus magic bytes. Attendance accepts JPEG/PNG/WebP;
  client-log selfies accept JPEG/PNG only.
- Store only relative database paths below `UPLOAD_DIR`.
- Manager/admin live subscribers use raw WebSocket + STOMP at `/ws`, topic
  `/topic/live-locations`. Phones send authenticated HTTP pings and do not open
  the dashboard socket.
- Without `REDIS_URL`, rate limits and WebSocket fan-out are single-instance.
  Configured Redis is required for shared limits/live events; never silently
  fall back during outages. Multiple replicas need the same private upload filesystem.

## 7. Verification

- Run `npm test` for every change.
- Run integration tests only with an explicitly isolated database whose name
  contains `test`; never fall back to the normal development database.
- Run `npm run db:generate` after Prisma model changes.
- Compare migrations/model on a disposable PostgreSQL database when schema
  changes affect native enums, constraints, or indexes.
