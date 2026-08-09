# Punch-In & Live Location Flow

Simple contract for how punch-in, verification details, and continuous location sharing work after login — for both frontend and backend.

---

## Goal

After an employee logs in and punches in:

1. They must grant location permission.
2. They submit verification details (selfie + opening odometer image + opening odo reading).
3. Punch-in is recorded.
4. Location keeps getting shared even when the app is minimized (Android foreground service + persistent notification).
5. Admin can later choose “send only one selected location” (feature flag / mode). For now, implement continuous sharing only.

---

## High-level flow

```
Login
  → Home (Punch In button)
  → Check location permission
      ✗ denied → block punch-in, prompt to enable location
      ✓ allowed → open Punch Details screen
  → Capture selfie + opening odo image + opening odo km
  → Confirm
  → Backend records punch-in
  → Start foreground location sharing (persistent notification)
  → Keep sending location pings while punched in
  → Punch out (closing odo later) → stop sharing
```

---

## Frontend flow

### 1. After login

- User lands on Home.
- UI shows **Punch In** when state is `notPunchedIn`.
- If already punched in (session restored from backend), skip to continuous sharing.

### 2. User taps Punch In

1. Request / check **location permission** (and location services ON).
2. If permission is missing:
   - Do **not** allow punch-in.
   - Show clear message + open app settings / system permission dialog.
3. If allowed:
   - Optionally fetch current location once (for display / first ping payload).
   - Navigate to **Punch Details** screen.

### 3. Punch Details screen (required before punch is final)

User must provide:

| Field | Required | Notes |
|-------|----------|--------|
| Selfie | Yes | Camera capture |
| Opening odo image | Yes | Photo of odometer |
| Opening odo km | Yes | Numeric reading |

On **Confirm**:

1. Upload images (or multipart with punch request).
2. Call punch-in API with:
   - selfie
   - opening odo image
   - opening odo km
   - current lat/lng (+ accuracy, timestamp)
3. On success:
   - Set local state to `punchedIn`
   - Start **foreground location service**
   - Show persistent notification: *“Location is being shared”*
4. On failure:
   - Keep user on details screen, show error, do not start sharing

### 4. Continuous location sharing (while punched in)

Android kills background work when the app is minimized unless a foreground service is running. So:

- Start a **foreground service** right after successful punch-in.
- Keep a **persistent notification** visible the whole time location is shared.
- Collect GPS on an interval (e.g. every 30–60s, or on significant movement).
- POST each ping to backend.
- If network fails, queue pings locally and retry when online.
- Sharing continues until **punch out** (or forced logout / session end).

iOS equivalent: background location updates + user-visible indication as required by the platform.

### 5. Punch out (related, later step)

- Collect closing odo image / km.
- Call punch-out API.
- Stop foreground service + remove notification.
- Stop sending location pings.

### 6. Admin feature (planned — not active yet)

Admin can enable a mode where **only one selected location** is sent (instead of continuous trail).

For now:

- Frontend always runs continuous sharing after punch-in.
- Backend should still support a future flag, e.g. `location_mode: continuous | single`.
- When `single` is enabled later: send one location at punch-in (and maybe at punch-out), skip stream.

---

## Backend flow

### Auth

- All endpoints require authenticated employee session (cookie / token already used by app).

### Punch-in

`POST /api/v1/attendance/punch-in` (name can match existing API style)

**Accepts:**

- `selfie` (image)
- `opening_odo_image` (image)
- `opening_odo_km` (number)
- `latitude`, `longitude`
- `accuracy` (optional)
- `captured_at` (optional timestamp from device)

**Rules:**

1. Reject if location permission was not used / lat-lng missing.
2. Reject if selfie or opening odo image missing.
3. Create attendance session: status = `punched_in`.
4. Store opening verification media + km.
5. Store first location point.
6. Return session id + punch-in time.

**Response (example):**

```json
{
  "session_id": "uuid",
  "status": "punched_in",
  "punched_in_at": "2026-08-09T10:15:00Z"
}
```

### Location pings (continuous)

`POST /api/v1/attendance/location-ping`

**Accepts:**

- `session_id`
- `latitude`, `longitude`
- `accuracy` (optional)
- `captured_at`
- `battery` / `speed` (optional)

**Rules:**

1. Only accept if employee has an active `punched_in` session.
2. Append point to that session’s location trail.
3. Ignore / soft-fail stale pings if needed, but do not crash the client.
4. If admin later sets `location_mode = single`, either:
   - reject further pings, or
   - accept but do not store beyond the selected one (prefer clear API contract).

### Current session

`GET /api/v1/attendance/current`

Used on app open / resume:

- If already punched in → frontend restores `punchedIn` and **restarts** foreground sharing.
- If not → show Punch In.

### Punch-out

`POST /api/v1/attendance/punch-out`

**Accepts:** closing odo image + km + final location.

**Rules:**

1. Close session.
2. Stop accepting location pings for that session.
3. Return punch-out time.

### Admin: single-location mode (future)

`PATCH /api/v1/admin/location-settings` (admin only)

```json
{
  "location_mode": "continuous" | "single"
}
```

- `continuous` (default now): store every ping.
- `single`: only keep / accept the location chosen or the punch-in location.

Frontend will read this setting (or get it in current-session response) and decide whether to keep the foreground stream running.

---

## Responsibility split

| Concern | Frontend | Backend |
|---------|----------|---------|
| Location permission gate | Yes | Reject punch-in without coords |
| Selfie + opening odo capture | Yes | Store + validate presence |
| Record punch-in | Calls API | Creates session |
| Persistent notification | Yes (OS foreground service) | — |
| Keep sharing while minimized | Yes | Accept + store pings |
| Restore session after kill/reopen | Restart service if still punched in | Provide current session |
| Admin single-location mode | Honor setting later | Own the setting + storage rules |

---

## State machine (app)

```
fetchingLocation
  → notPunchedIn
  → (details confirmed) punchedIn   ← location stream ON + notification ON
  → punchingOut
  → punchedOut                      ← location stream OFF + notification OFF
```

Matches current app punch states: `fetchingLocation`, `notPunchedIn`, `punchedIn`, `punchingOut`, `punchedOut`.

---

## Non-negotiables

1. **No punch-in without location permission.**
2. **No punch-in without selfie + opening odo image + opening odo km.**
3. **After punch-in, location sharing must survive app minimize** via foreground service + always-visible notification.
4. **Backend only stores pings for an active punched-in session.**
5. **Admin single-location mode is designed for, but continuous sharing is what we ship first.**

---

## Suggested implementation order

1. Backend: punch-in + current session + location-ping + punch-out.
2. Frontend: permission gate → details screen → punch-in API.
3. Frontend: Android/iOS foreground location + notification.
4. Frontend: resume/restore sharing from current session.
5. Admin single-location setting (later).
