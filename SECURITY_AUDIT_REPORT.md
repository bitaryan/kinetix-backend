# GPSS Backend Security Audit Report

**Date:** 2026-08-08  
**Scope:** FastAPI authentication API (`/api/v1/auth/*`, `/health`, OpenAPI)  
**Method:** Code review + executable API/security pytest suite  
**Test result:** **40 passed** (`pytest tests/`)

---

## Executive summary

The auth stack has solid foundations: Argon2 passwords, HttpOnly refresh cookies, hashed refresh tokens at rest, session revocation on logout, DB-backed RBAC (JWT role claim not trusted for authorization), and CORS origin allowlisting.

**8 vulnerabilities** were confirmed by automated tests. The highest priority is **refresh-token reuse without session kill** (stolen refresh token can keep a valid session after the victim’s stale token fails).

| Severity | Count |
| --- | --- |
| Critical | 0 |
| High | 1 |
| Medium | 5 |
| Low | 2 |

---

## Test case inventory

### Functional API cases (`tests/test_api_auth_flows.py`)

| ID | Case | Result |
| --- | --- | --- |
| F-01 | Health endpoint returns `{status: ok}` | Pass |
| F-02 | `/me` without bearer → 401 `UNAUTHORIZED` | Pass |
| F-03 | Login validation rejects short password → 422 | Pass |
| F-04 | Successful login returns access token + HttpOnly cookie | Pass |
| F-05 | Wrong password → `INVALID_CREDENTIALS` | Pass |
| F-06 | Unknown user → `INVALID_CREDENTIALS` | Pass |
| F-07 | Wrong role → `INVALID_CREDENTIALS` | Pass |
| F-08 | Account locks after 5 failed passwords (15 min policy) | Pass |
| F-09 | `/me` with valid token returns profile | Pass |
| F-10 | Tampered JWT rejected | Pass |
| F-11 | Logout revokes access immediately | Pass |
| F-12 | Logout-all revokes all sessions | Pass |
| F-13 | Refresh rotates cookie; stale refresh rejected | Pass |
| F-14 | Refresh without cookie → `INVALID_REFRESH_TOKEN` | Pass |
| F-15 | Admin can create employee | Pass |
| F-16 | Employee cannot create users → 403 | Pass |
| F-17 | Manager cannot create users → 403 | Pass |
| F-18 | Duplicate employee ID → 409 | Pass |

### Secure-control cases (`tests/test_security_vulnerabilities.py`)

| ID | Control | Result |
| --- | --- | --- |
| C-01 | Password hash never returned | Pass |
| C-02 | `alg=none` / wrong-secret JWT rejected | Pass |
| C-03 | Forged JWT `role=ADMIN` cannot escalate (DB role used) | Pass |
| C-04 | CORS does not reflect arbitrary origins | Pass |
| C-05 | Refresh cookie is HttpOnly | Pass |
| C-06 | Revoked session rejects access token | Pass |
| C-07 | Refresh token stored as SHA-256 hash only | Pass |

### Vulnerability confirmation cases (pass = issue reproduced)

| ID | Finding | Severity | Result |
| --- | --- | --- | --- |
| VULN-001 | Refresh reuse does not revoke stolen session | High | Confirmed |
| VULN-002 | Wrong role skips lockout counter | Medium | Confirmed |
| VULN-003 | Lock status discloses valid user IDs | Medium | Confirmed |
| VULN-004 | Admin can provision additional admins | Medium | Confirmed |
| VULN-005 | Password policy is length-only | Low | Confirmed |
| VULN-006 | Cookie `Secure` flag off by default | Medium | Confirmed |
| VULN-007 | OpenAPI `/docs` publicly exposed | Low | Confirmed |
| VULN-008 | No IP/global login rate limit | Medium | Confirmed |

---

## Vulnerability details

### VULN-001 — Refresh token reuse does not kill the active session (High)

**Location:** `app/modules/auth/service.py` (`refresh`)  
**Test:** `test_vuln_refresh_reuse_does_not_revoke_stolen_session`

**Issue:** When a stolen refresh token is used first, the session hash is rotated to the attacker’s new token. The victim’s later refresh with the old token returns `401` because the hash is no longer found, but the code path for `active_session is None` does **not** revoke the session. The attacker’s rotated session remains valid.

**Impact:** Refresh-token theft (XSS on a sibling origin, malware, shared device) can persist even after the legitimate client notices refresh failure.

**Remediation:** Implement refresh-token reuse detection / token families: if an old token is presented after rotation, revoke the entire session (or all sessions for that user) and force re-login.

---

### VULN-002 — Wrong role bypasses failed-attempt lockout (Medium)

**Location:** `app/modules/auth/service.py` (`login`, role check before password verify)  
**Test:** `test_vuln_wrong_role_skips_lockout_counter`

**Issue:** `user.role != payload.role` returns `INVALID_CREDENTIALS` without incrementing `no_of_attempts` and without running Argon2 verification.

**Impact:** Attackers can probe roles / spray passwords under wrong roles without triggering the 5-attempt lockout. Timing differences vs password checks also aid role inference.

**Remediation:** Always verify the password (or dummy hash) and increment attempts on any failed authentication factor, including role mismatch. Prefer not requiring role on login if the server already knows the user’s role.

---

### VULN-003 — Account lock response discloses valid employee IDs (Medium)

**Location:** `app/modules/auth/service.py` (locked-account branch)  
**Test:** `test_vuln_account_lock_status_discloses_valid_user_id`

**Issue:** Existing locked accounts return `429 ACCOUNT_LOCKED`; unknown IDs return `401 INVALID_CREDENTIALS`.

**Impact:** Confirms which `userId` values exist after lockout (or enables lock-then-enumerate workflows).

**Remediation:** Return the same generic `401 INVALID_CREDENTIALS` (optionally with identical timing) for locked, missing, inactive, and wrong-password cases. Enforce lockout server-side without signaling it.

---

### VULN-004 — Unrestricted admin self-replication (Medium)

**Location:** `app/api/v1/endpoints/auth.py` (`POST /users`) + `CreateUserRequest.role`  
**Test:** `test_vuln_admin_can_provision_additional_admins`

**Issue:** Any `ADMIN` can create another `ADMIN` with no approval gate or role ceiling.

**Impact:** Compromised admin credentials or insider abuse quickly expands privileged accounts.

**Remediation:** Restrict creatable roles (e.g. only `EMPLOYEE`/`MANAGER` via API), or require dual-control / break-glass for `ADMIN` creation.

---

### VULN-005 — Weak password complexity policy (Low)

**Location:** `app/modules/auth/schemas.py` (`CreateUserRequest.password`)  
**Test:** `test_vuln_password_policy_allows_weak_complexity`

**Issue:** Minimum length 12 with no complexity / breach-check requirements. `aaaaaaaaaaaa` is accepted.

**Impact:** Easier online guessing and reuse of weak passwords despite Argon2 hashing.

**Remediation:** Enforce complexity or zxcvbn/HIBP checks; align login min length with create-user policy.

---

### VULN-006 — Refresh cookie missing `Secure` by default (Medium)

**Location:** `app/core/config.py` (`cookie_secure: bool = False`), `auth.py` `_set_refresh_cookie`  
**Test:** `test_vuln_cookie_secure_flag_disabled_by_default`

**Issue:** With `COOKIE_SECURE=false`, the refresh cookie can be sent over HTTP.

**Impact:** Token theft on cleartext networks if production misconfiguration ships defaults.

**Remediation:** Default `COOKIE_SECURE=true` when `APP_ENV=production`; fail startup if production and secure cookies are disabled.

---

### VULN-007 — Public OpenAPI /docs surface (Low)

**Location:** FastAPI defaults (`/docs`, `/openapi.json`)  
**Test:** `test_vuln_openapi_docs_exposed_without_auth`

**Issue:** Interactive docs and full schema are anonymously reachable.

**Impact:** Speeds reconnaissance of auth endpoints and schemas.

**Remediation:** Disable docs in production (`docs_url=None`, `redoc_url=None`, `openapi_url=None`) or protect them behind admin auth.

---

### VULN-008 — No IP / global rate limiting on login (Medium)

**Location:** Application layer (lockout is per-account only)  
**Test:** `test_vuln_no_login_rate_limit_across_accounts`

**Issue:** Credential stuffing across many employee IDs receives only `401` responses with no IP throttle.

**Impact:** Distributed password spraying remains practical.

**Remediation:** Add gateway/WAF or app-level rate limits (per IP + per userId) on `/login` and `/refresh`, as already noted in `AUTHENTICATION.md`.

---

## Additional observations (not separately numbered)

| Topic | Notes |
| --- | --- |
| Client IP logging | Uses `request.client.host` only — correct against spoofing without proxy trust, wrong behind reverse proxies until trusted-proxy middleware is added. |
| JWT `role` claim | Present in token but authorization uses DB role — good. Consider omitting role from JWT to reduce confusion. |
| Positive controls | Logout revocation, hashed refresh storage, Argon2, CORS allowlist, and algorithm pinning (`HS256` only) behaved correctly in tests. |

---

## Recommended fix order

1. **VULN-001** — refresh reuse → revoke session/family  
2. **VULN-002** + **VULN-003** — unify login failure handling / lockout signaling  
3. **VULN-008** + **VULN-006** — rate limit + secure cookie defaults for production  
4. **VULN-004** — constrain admin provisioning  
5. **VULN-005** + **VULN-007** — password policy + hide docs in production  

---

## How to re-run

```bash
# Requires PostgreSQL with role/db gpss:gpss and migrations applied
alembic upgrade head
PYTHONPATH=. pytest tests/ -v
PYTHONPATH=. pytest tests/ -m security_finding -v   # vulnerability probes only
```

Evidence for each finding lives in `tests/test_security_vulnerabilities.py` under `TestVulnerabilityFindings`.
