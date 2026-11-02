-- Pix pendente: configuração explícita de consentimento, tipo de job e
-- idempotência por pedido. O default unknown mantém o fluxo fechado até que
-- o opt-in real seja registrado.
ALTER TABLE recovery_leads
  ADD COLUMN IF NOT EXISTS whatsapp_consent_status TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE recovery_leads
  ADD COLUMN IF NOT EXISTS whatsapp_consent_at TIMESTAMP;

ALTER TABLE message_jobs
  ADD COLUMN IF NOT EXISTS job_type TEXT;

ALTER TABLE message_jobs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS message_jobs_idempotency_key_unique
  ON message_jobs (idempotency_key);
