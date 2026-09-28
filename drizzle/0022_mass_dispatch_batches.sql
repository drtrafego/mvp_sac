CREATE TABLE IF NOT EXISTS "mass_dispatch_batches" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "file_name" text,
  "event_type" text NOT NULL,
  "tracking_source" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "recipient_count" integer DEFAULT 0 NOT NULL,
  "confirmed_at" timestamp,
  "created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mass_dispatch_recipients" (
  "id" serial PRIMARY KEY NOT NULL,
  "batch_id" integer NOT NULL REFERENCES "mass_dispatch_batches"("id") ON DELETE cascade,
  "lead_id" integer NOT NULL REFERENCES "recovery_leads"("id") ON DELETE cascade,
  "created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mass_dispatch_recipients_batch_lead_unique" ON "mass_dispatch_recipients" ("batch_id", "lead_id");
--> statement-breakpoint
ALTER TABLE "message_jobs" ADD COLUMN IF NOT EXISTS "mass_dispatch_batch_id" integer REFERENCES "mass_dispatch_batches"("id") ON DELETE set null;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "message_jobs_mass_dispatch_unique" ON "message_jobs" ("mass_dispatch_batch_id", "lead_id", "message_id");
