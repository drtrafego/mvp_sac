ALTER TABLE "mass_dispatch_batches"
  ADD COLUMN IF NOT EXISTS "requested_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "mass_dispatch_batches"
  ADD COLUMN IF NOT EXISTS "skipped_count" integer NOT NULL DEFAULT 0;
