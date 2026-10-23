-- Otoni adapter: durable retry key, scoped per tenant.
ALTER TABLE sac_approved_replies ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS sac_approved_replies_company_idempotency_unique
  ON sac_approved_replies (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
