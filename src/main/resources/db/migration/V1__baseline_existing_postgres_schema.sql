-- Baseline of the Alembic-managed schema (revisions 20260808_0001 through 20260811_0007).
-- Flyway baseline-on-migrate is enabled so existing production databases are not rebuilt.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
        CREATE TYPE user_role AS ENUM ('ADMIN', 'MANAGER', 'EMPLOYEE');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attendance_status') THEN
        CREATE TYPE attendance_status AS ENUM ('punched_in', 'punched_out');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'location_mode') THEN
        CREATE TYPE location_mode AS ENUM ('continuous', 'single');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'leave_status') THEN
        CREATE TYPE leave_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS users (
    user_id UUID PRIMARY KEY,
    employee_id VARCHAR(30) NOT NULL UNIQUE,
    employee_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role user_role NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    no_of_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS active_sessions (
    session_id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    refresh_token_hash VARCHAR(64) NOT NULL UNIQUE,
    previous_refresh_token_hash VARCHAR(64) UNIQUE,
    user_agent TEXT,
    ip_address VARCHAR(45),
    is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_active_sessions_user_id ON active_sessions (user_id);

CREATE TABLE IF NOT EXISTS attendance_sessions (
    session_id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    status attendance_status NOT NULL,
    opening_odo_km NUMERIC(10, 2) NOT NULL,
    opening_selfie_path VARCHAR(512) NOT NULL,
    opening_odo_image_path VARCHAR(512) NOT NULL,
    closing_odo_km NUMERIC(10, 2),
    closing_odo_image_path VARCHAR(512),
    punch_in_latitude DOUBLE PRECISION NOT NULL,
    punch_in_longitude DOUBLE PRECISION NOT NULL,
    punch_in_accuracy DOUBLE PRECISION,
    punch_out_latitude DOUBLE PRECISION,
    punch_out_longitude DOUBLE PRECISION,
    punch_out_accuracy DOUBLE PRECISION,
    punched_in_at TIMESTAMPTZ NOT NULL,
    punched_out_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_attendance_sessions_user_id ON attendance_sessions (user_id);
CREATE INDEX IF NOT EXISTS ix_attendance_sessions_user_status ON attendance_sessions (user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_sessions_one_active_per_user
    ON attendance_sessions (user_id)
    WHERE status = 'punched_in';

CREATE TABLE IF NOT EXISTS location_pings (
    ping_id UUID PRIMARY KEY,
    attendance_session_id UUID NOT NULL REFERENCES attendance_sessions (session_id) ON DELETE CASCADE,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    accuracy DOUBLE PRECISION,
    captured_at TIMESTAMPTZ NOT NULL,
    battery DOUBLE PRECISION,
    speed DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_location_pings_attendance_session_id ON location_pings (attendance_session_id);
CREATE INDEX IF NOT EXISTS ix_location_pings_session_captured_at
    ON location_pings (attendance_session_id, captured_at);

CREATE TABLE IF NOT EXISTS location_settings (
    settings_id UUID PRIMARY KEY,
    singleton_key VARCHAR(32) NOT NULL,
    location_mode location_mode NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_location_settings_singleton UNIQUE (singleton_key)
);

INSERT INTO location_settings (settings_id, singleton_key, location_mode)
SELECT gen_random_uuid(), 'default', 'continuous'
WHERE NOT EXISTS (SELECT 1 FROM location_settings WHERE singleton_key = 'default');

CREATE TABLE IF NOT EXISTS client_logs (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    client_name VARCHAR(150) NOT NULL,
    company_name VARCHAR(200) NOT NULL,
    mobile_number VARCHAR(20) NOT NULL,
    mail_id VARCHAR(255) NOT NULL,
    log_date DATE NOT NULL,
    selfie_path TEXT,
    latitude NUMERIC(10, 8),
    longitude NUMERIC(11, 8),
    location_accuracy DOUBLE PRECISION,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_client_logs_user_id ON client_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_client_logs_log_date ON client_logs (log_date DESC);
CREATE INDEX IF NOT EXISTS idx_client_logs_search ON client_logs (client_name, company_name, mobile_number);

CREATE TABLE IF NOT EXISTS leaves (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    status leave_status NOT NULL DEFAULT 'PENDING',
    approved_by UUID REFERENCES users (user_id) ON DELETE SET NULL,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_leaves_date_range CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_leaves_user_id ON leaves (user_id);
CREATE INDEX IF NOT EXISTS idx_leaves_created_at ON leaves (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leaves_status ON leaves (status);
CREATE INDEX IF NOT EXISTS idx_leaves_user_dates ON leaves (user_id, start_date, end_date);
