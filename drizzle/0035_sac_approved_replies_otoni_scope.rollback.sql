-- Rollback manual for 0035_sac_approved_replies_otoni_scope.sql.
-- Run only after confirming no Otoni writes depend on this column/index.
DROP INDEX IF EXISTS sac_approved_replies_company_idempotency_unique;
ALTER TABLE sac_approved_replies DROP COLUMN IF EXISTS idempotency_key;
