# AGENTS.md — GPSS Backend

Java 21 + Spring Boot API. Do not change HTTP contracts to look more "Spring-like".

**Read first:** [`docs/JAVA_REWRITE.md`](docs/JAVA_REWRITE.md) — paths, JSON keys, error codes, cookie attributes.

---

## 1. Tech stack

- **Language**: Java 21
- **Framework**: Spring Boot 3.3+ (servlet stack)
- **Database**: PostgreSQL 16 (Flyway; never `ddl-auto=create`)
- **Persistence**: Spring Data JPA / Hibernate — **NO raw SQL in application code**
- **Auth**: JWT access token in JSON (`Authorization: Bearer`) + opaque refresh token in **HttpOnly cookie** `refresh_token` with path `/api/v1/auth`
- **Passwords**: Argon2id; must verify existing PHC hashes in `users.password_hash`
- **Roles**: `ADMIN`, `MANAGER`, `EMPLOYEE` (DB enum `user_role`)
- **Validation**: Bean Validation on DTOs
- **JSON**: Jackson with **explicit `@JsonProperty`**. Do not set global `SNAKE_CASE` — the live API mixes camelCase and snake_case by endpoint
- **Tests**: JUnit 5 + MockMvc + Testcontainers PostgreSQL
- **Package root**: `com.gpss.backend`

---

## 2. Architecture

Feature packages: `auth`, `attendance`, `clientlog`, `leave`, `upload`.

Inside each feature:

- **api** (`@RestController`): HTTP parsing and response mapping ONLY
- **application** (`@Service`): business logic (lockout, overlap, punch rules, GPS accept/reject)
- **infra** (Spring Data repositories): ORM ONLY
- **web / dto**: request and response records
- **domain**: JPA entities and enums

Do not put business rules in controllers or repositories.

---

## 3. Database & ORM

- Columns: `snake_case` (`employee_name`, `no_of_attempts`, `locked_until`)
- Java fields: `camelCase` + `@Column(name = "...")`
- PK column names often differ from Java (`user_id`, `session_id`, `ping_id`)
- Enum **stored values** (not Java names):
  - attendance: `punched_in` / `punched_out`
  - location mode: `continuous` / `single`
  - leave: `PENDING` / `APPROVED` / `REJECTED` / `CANCELLED`
- Schema changes: Flyway SQL only. Never alter tables by hand or via Hibernate DDL.

---

## 4. Authentication & security

- Login identifier is **employee ID** (`userId` JSON), stored uppercase — not email
- Failed password or wrong role: increment `no_of_attempts`; at **≥ 5** lock 15 minutes (`locked_until`)
- Same public error for unknown user, lockout, inactive, bad password, wrong role: `401 INVALID_CREDENTIALS` `"Invalid user ID or password"`
- One active refresh session per user on login (revoke others)
- Refresh **rotation** + reuse of `previous_refresh_token_hash` revokes **all** sessions for that user
- Check `is_revoked == false` and `expires_at` on refresh and on every Bearer request (session row)
- Never log passwords, never return `password_hash` or the refresh token in JSON
- GPS business failures are **HTTP 200** with `data.accepted = false` and `data.reason` — not 4xx

---

## 5. Standard API envelope

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

Leaves list also has `meta: { total, page, limit }`.
Client-log list has `meta: { page, limit, totalCount, totalPages }`.

Copy **exact** `code` strings and cookie flags from `docs/JAVA_REWRITE.md`. Inventing new codes breaks the mobile app.

---

## 6. Contract rules

1. Do not change paths, status codes, error `code` strings, or JSON keys without a client release.
2. Attendance GPS: preserve soft-fail reasons (`TOO_FREQUENT`, `STALE_PING`, `SESSION_NOT_ACTIVE`, `SINGLE_LOCATION_MODE`, `SESSION_TRAIL_FULL`, `INVALID_TIMESTAMP`, `SESSION_NOT_FOUND`).
3. Leave JSON dates are `DD/MM/YY`; status strings are title-case (`Pending`). Auth/attendance JSON is mostly camelCase.
4. Uploads: magic-byte image check; employees may only read their own files under `/uploads/**`.
