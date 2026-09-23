-- Metadados do registro nativo crm_leads preservados no SAC.
-- Aplicação em produção ocorre também por ensureSchema() em src/lib/db/index.ts.
ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS company text;
ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS notes text;
