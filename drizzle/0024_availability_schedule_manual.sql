ALTER TABLE "settings"
ADD COLUMN IF NOT EXISTS "availability_schedule_manual" boolean NOT NULL DEFAULT false;
