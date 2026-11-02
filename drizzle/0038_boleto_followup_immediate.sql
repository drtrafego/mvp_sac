ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS whatsapp_consent_status text NOT NULL DEFAULT 'unknown';
ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS whatsapp_consent_at timestamp;
ALTER TABLE message_jobs ADD COLUMN IF NOT EXISTS job_type text;
ALTER TABLE message_jobs ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS message_jobs_idempotency_key_unique ON message_jobs (idempotency_key);
