-- Additive repair for installations which already executed Lote 1 bootstrap/0029.
-- No historical message is retrospectively classified as accepted or failed.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS sac_followup_stage_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS sac_case_episode INTEGER NOT NULL DEFAULT 1;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS outbound_payload_hash TEXT;
ALTER TABLE whatsapp_messages ALTER COLUMN send_state DROP DEFAULT;
ALTER TABLE sac_approved_replies ALTER COLUMN approval_state SET DEFAULT 'draft';
-- Fail clearly on legacy duplicates; never delete members/notes/owners to make this pass.
CREATE UNIQUE INDEX IF NOT EXISTS company_members_company_user_unique
ON company_members (company_id, stack_auth_user_id) WHERE stack_auth_user_id IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'recovery_leads_request_message_id_fkey'
      AND conrelid = 'recovery_leads'::regclass
  ) THEN
    -- NOT VALID preserves legacy records until explicitly audited; new writes are checked.
    ALTER TABLE recovery_leads ADD CONSTRAINT recovery_leads_request_message_id_fkey
      FOREIGN KEY (request_message_id) REFERENCES whatsapp_messages(id)
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS sac_rule_states (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES recovery_leads(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  fingerprint TEXT,
  occurrence_number INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS sac_rule_states_company_lead_rule_unique
ON sac_rule_states (company_id, lead_id, rule_type);
