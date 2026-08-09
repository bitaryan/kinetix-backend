# Frontend → Backend Connection Roadmap

What must change in `gpss_frontend` to talk to this backend.  
Frontend currently uses mock/local navigation — replace those with real API calls.

Backend base path: `http://<host>:8000/api/v1`  
Auth contract: camelCase JSON + Bearer access token + HttpOnly `refresh_token` cookie.

---

## 0. Prerequisites (not frontend code)

- Backend running: `uvicorn app.main:app --reload --host 0.0.0.0 --port 8000`
- Admin (or test user) exists via `python -m app.scripts.create_admin`
- Pick correct host for the device:
  - iOS Simulator / desktop: `127.0.0.1`
  - Android Emulator: `10.0.2.2`
  - Physical phone: Mac LAN IP

---

## 1. Required file changes

### 1.1 `lib/core/network/api_client.dart`

| # | Change |
|---|--------|
| 1 | Replace `baseUrl: 'https://api.example.com'` with `http://<host>:8000/api/v1` |
| 2 | Login body: send `userId` (not `user_id`) |
| 3 | Login body: send `role` as `ADMIN` \| `MANAGER` \| `EMPLOYEE` |
| 4 | Parse success from `data.accessToken`, `data.user`, `data.expiresIn` |
| 5 | Parse errors from `error.message` / `error.code` (not top-level `message`) |
| 6 | Add helper to set `Authorization: Bearer <accessToken>` on Dio |
| 7 | Add methods: `refresh` → `POST /auth/refresh`, `logout` → `POST /auth/logout`, `me` → `GET /auth/me` |
| 8 | (Mobile) Attach cookie jar so refresh cookie is stored/sent (`dio_cookie_manager` + `cookie_jar`) |

**Login request body (exact):**
```json
{ "userId": "ARYAN", "password": "...", "role": "ADMIN" }
```

**Login success shape:**
```json
{
  "success": true,
  "data": {
    "accessToken": "...",
    "tokenType": "bearer",
    "expiresIn": 900,
    "user": {
      "userId": "...",
      "employeeName": "...",
      "email": "...",
      "role": "...",
      "isActive": true,
      "createdAt": "..."
    }
  },
  "error": null
}
```

---

### 1.2 `lib/features/auth/presentation/screens/login_screen.dart`

| # | Change |
|---|--------|
| 1 | Stop mock flow: remove “just `context.go(home)` on tap” |
| 2 | Call `ApiClient.login` with userId/password + mapped role |
| 3 | Map UI role labels → API enums (`Admin` → `ADMIN`, etc.) |
| 4 | On success: save `accessToken` (and user profile if needed), then navigate home |
| 5 | On failure: show `error.message` — do not navigate |
| 6 | Loading state on button while request in flight |
| 7 | Relax password max length if needed (backend allows up to 128; UI truncates at 20 today) |
| 8 | User ID max 10 is OK for short IDs like `ARYAN`; raise if longer IDs are used |

---

### 1.3 Token / session storage

| # | Change |
|---|--------|
| 1 | Persist `accessToken` (SharedPreferences already available; prefer secure storage later) |
| 2 | Persist basic user fields needed by UI (`userId`, `role`, `employeeName`) |
| 3 | On app start: if token exists, set Bearer header; optionally call `GET /auth/me` |
| 4 | On 401: try `POST /auth/refresh` once; if that fails, clear storage → login |
| 5 | On logout: `POST /auth/logout`, clear storage → login |

---

### 1.4 Auth / router guards

| # | Change |
|---|--------|
| 1 | Gate home/protected routes on real auth state (token present / valid), not mock flags |
| 2 | Unauthenticated → login; authenticated visiting login → home |
| 3 | Wire logout UI to real logout API |

---

### 1.5 Platform config (HTTP to local backend)

| # | File | Change |
|---|------|--------|
| 1 | `android/app/src/main/AndroidManifest.xml` | `android:usesCleartextTraffic="true"` on `<application>` |
| 2 | `ios/Runner/Info.plist` | ATS exception for local IP / localhost if HTTP is blocked |

---

### 1.6 Flutter web only (skip for mobile)

| # | Change |
|---|--------|
| 1 | Backend `.env` `BACKEND_CORS_ORIGINS` must include the Flutter web origin |
| 2 | Browser/Dio must send credentials if using the refresh cookie |

---

## 2. Optional / later (not blocking first login)

| # | Change |
|---|--------|
| 1 | Admin create-user UI → `POST /auth/users` |
| 2 | `POST /auth/logout-all` |
| 3 | Auto-refresh interceptor using `expiresIn` |
| 4 | `flutter_secure_storage` for access token |
| 5 | Env-based base URL (dev / staging / prod) |

---

## 3. Minimum endpoints to wire

| UI action | Method | Path | Auth |
|-----------|--------|------|------|
| Login | POST | `/auth/login` | none (sets refresh cookie) |
| Session / profile | GET | `/auth/me` | Bearer |
| Refresh | POST | `/auth/refresh` | refresh cookie |
| Logout | POST | `/auth/logout` | Bearer |

---

## 4. Done when

- [ ] Login with real credentials hits backend and returns `accessToken`
- [ ] Token saved and sent on `GET /auth/me`
- [ ] Failed login shows backend error, stays on login
- [ ] Logout clears token and returns to login
- [ ] Refresh keeps session without re-typing password

---

## 5. Common mismatches (do not send)

| Wrong | Correct |
|-------|---------|
| `user_id` | `userId` |
| `employee_id` | `userId` |
| role `Admin` / `admin` | `ADMIN` |
| Reading `response.message` | `response.error.message` |
| Base URL without `/api/v1` | `...:8000/api/v1` |
| Mixing `localhost` and `127.0.0.1` for cookies | Use one host consistently |
