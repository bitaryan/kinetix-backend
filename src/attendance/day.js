// Attendance days use Asia/Kolkata (UTC+05:30, no daylight-saving changes).
const DAY_MS = 86_400_000;
const INDIA_OFFSET_MS = 330 * 60_000;

export function attendanceDay(at) {
  const start = Math.floor((at.getTime() + INDIA_OFFSET_MS) / DAY_MS) * DAY_MS - INDIA_OFFSET_MS;
  return { start: new Date(start), end: new Date(start + DAY_MS), cutoff: new Date(start + 20 * 3_600_000) };
}

export function autoPunchOutAt(punchedInAt) {
  // Legacy shifts may have started after 8 PM. Never record a negative shift.
  return new Date(Math.max(punchedInAt.getTime(), attendanceDay(punchedInAt).cutoff.getTime()));
}
