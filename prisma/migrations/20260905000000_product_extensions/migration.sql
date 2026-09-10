-- CreateTable
CREATE TABLE "audit_events" (
    "event_id" UUID NOT NULL,
    "actor_id" UUID,
    "subject_id" UUID,
    "action" VARCHAR(80) NOT NULL,
    "resource_id" UUID NOT NULL,
    "details" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "password_resets" (
    "reset_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_resets_pkey" PRIMARY KEY ("reset_id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "notification_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" VARCHAR(80) NOT NULL,
    "payload" JSONB NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("notification_id")
);

-- CreateTable
CREATE TABLE "delivery_jobs" (
    "job_id" UUID NOT NULL,
    "type" VARCHAR(80) NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(6),
    "lock_token" UUID,
    "delivered_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_jobs_pkey" PRIMARY KEY ("job_id")
);

-- CreateTable
CREATE TABLE "leave_entitlements" (
    "entitlement_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "days" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_entitlements_pkey" PRIMARY KEY ("entitlement_id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "holiday_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" VARCHAR(150) NOT NULL,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("holiday_id")
);

-- CreateTable
CREATE TABLE "workforce_policies" (
    "key" VARCHAR(32) NOT NULL DEFAULT 'default',
    "weekend_days" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "daily_overtime_minutes" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workforce_policies_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "geofences" (
    "geofence_id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "radius_meters" DOUBLE PRECISION NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "geofences_pkey" PRIMARY KEY ("geofence_id")
);

-- CreateTable
CREATE TABLE "geofence_states" (
    "state_id" UUID NOT NULL,
    "geofence_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "inside" BOOLEAN NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "geofence_states_pkey" PRIMARY KEY ("state_id")
);

-- CreateIndex
CREATE INDEX "ix_audit_resource_time" ON "audit_events"("resource_id", "created_at", "event_id");

-- CreateIndex
CREATE INDEX "ix_audit_time" ON "audit_events"("created_at", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_resets_token_hash_key" ON "password_resets"("token_hash");

-- CreateIndex
CREATE INDEX "ix_password_resets_user_time" ON "password_resets"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_password_resets_expiry" ON "password_resets"("expires_at");

-- CreateIndex
CREATE INDEX "ix_notifications_user_time" ON "notifications"("user_id", "created_at", "notification_id");

-- CreateIndex
CREATE INDEX "ix_delivery_jobs_pending" ON "delivery_jobs"("delivered_at", "failed_at", "available_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_leave_entitlement_user_year" ON "leave_entitlements"("user_id", "year");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_date_key" ON "holidays"("date");

-- CreateIndex
CREATE UNIQUE INDEX "uq_geofence_session_state" ON "geofence_states"("geofence_id", "session_id");

-- CreateIndex
CREATE INDEX "ix_attendance_history_user_time" ON "attendance_sessions"("user_id", "punched_in_at", "session_id");

-- CreateIndex
CREATE INDEX "ix_attendance_history_time" ON "attendance_sessions"("punched_in_at", "session_id");

-- AddForeignKey
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "leave_entitlements" ADD CONSTRAINT "leave_entitlements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "geofence_states" ADD CONSTRAINT "geofence_states_geofence_id_fkey" FOREIGN KEY ("geofence_id") REFERENCES "geofences"("geofence_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "geofence_states" ADD CONSTRAINT "geofence_states_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "attendance_sessions"("session_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Additional invariants that Prisma cannot express in its data model.
ALTER TABLE "leave_entitlements" ADD CONSTRAINT "chk_leave_entitlement"
  CHECK ("year" BETWEEN 2000 AND 2099 AND "days" BETWEEN 0 AND 366);
ALTER TABLE "workforce_policies" ADD CONSTRAINT "chk_workforce_policy"
  CHECK ("key" = 'default' AND cardinality("weekend_days") <= 6
    AND "weekend_days" <@ ARRAY[0,1,2,3,4,5,6]
    AND ("daily_overtime_minutes" IS NULL OR "daily_overtime_minutes" BETWEEN 1 AND 1440));
ALTER TABLE "geofences" ADD CONSTRAINT "chk_geofence_coordinates"
  CHECK ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180
    AND "radius_meters" BETWEEN 25 AND 100000);
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "chk_delivery_attempts" CHECK ("attempts" >= 0);
