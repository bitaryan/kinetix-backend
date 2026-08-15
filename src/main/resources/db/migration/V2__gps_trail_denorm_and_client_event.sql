-- Additive GPS trail upgrades. Existing clients omit the new optional columns.

ALTER TABLE attendance_sessions
    ADD COLUMN IF NOT EXISTS ping_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_known_latitude DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS last_known_longitude DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS last_known_accuracy DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS last_known_captured_at TIMESTAMPTZ;

ALTER TABLE location_pings
    ADD COLUMN IF NOT EXISTS client_event_id UUID,
    ADD COLUMN IF NOT EXISTS is_mock BOOLEAN,
    ADD COLUMN IF NOT EXISTS accuracy_flag VARCHAR(32);

CREATE UNIQUE INDEX IF NOT EXISTS uq_location_pings_session_client_event
    ON location_pings (attendance_session_id, client_event_id)
    WHERE client_event_id IS NOT NULL;

UPDATE attendance_sessions AS s
SET ping_count = sub.cnt,
    last_known_latitude = sub.latitude,
    last_known_longitude = sub.longitude,
    last_known_accuracy = sub.accuracy,
    last_known_captured_at = sub.captured_at
FROM (
    SELECT DISTINCT ON (attendance_session_id)
        attendance_session_id,
        latitude,
        longitude,
        accuracy,
        captured_at,
        COUNT(*) OVER (PARTITION BY attendance_session_id) AS cnt
    FROM location_pings
    ORDER BY attendance_session_id, captured_at DESC, ping_id DESC
) AS sub
WHERE s.session_id = sub.attendance_session_id;

CREATE INDEX IF NOT EXISTS ix_attendance_sessions_active_last_known
    ON attendance_sessions (status, last_known_captured_at DESC)
    WHERE status = 'punched_in';
