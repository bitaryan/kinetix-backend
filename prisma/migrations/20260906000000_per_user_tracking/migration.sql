-- Preserve existing accounts' tracking access; new accounts require admin opt-in.
ALTER TABLE "users" ADD COLUMN "location_tracking_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ALTER COLUMN "location_tracking_enabled" SET DEFAULT false;
ALTER TABLE "users" ADD COLUMN "location_tracking_since" TIMESTAMPTZ(6);

-- Untracked shifts still record punch coordinates, but have no odometer data.
ALTER TABLE "attendance_sessions" ALTER COLUMN "opening_odo_km" DROP NOT NULL;
ALTER TABLE "attendance_sessions" ALTER COLUMN "opening_odo_image_path" DROP NOT NULL;
