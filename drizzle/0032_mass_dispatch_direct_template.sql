ALTER TABLE mass_dispatch_batches ADD COLUMN dispatch_source text NOT NULL DEFAULT 'sequence';
ALTER TABLE mass_dispatch_batches ADD COLUMN template_name text;
ALTER TABLE mass_dispatch_batches ADD COLUMN template_language text;
ALTER TABLE mass_dispatch_batches ADD COLUMN template_variables_map jsonb;
ALTER TABLE mass_dispatch_batches ADD COLUMN template_snapshot jsonb;
ALTER TABLE mass_dispatch_batches ADD COLUMN updated_at timestamp;
--> statement-breakpoint
CREATE UNIQUE INDEX message_jobs_direct_template_unique ON message_jobs (mass_dispatch_batch_id, lead_id) WHERE mass_dispatch_batch_id IS NOT NULL AND message_id IS NULL;
