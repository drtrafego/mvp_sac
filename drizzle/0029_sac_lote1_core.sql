-- 0029_sac_lote1_core.sql
-- SAC Lote 1: Fundação de envio, pausa com controle de versão, card de contexto,
-- notas internas datadas, respostas aprovadas, 3 regras internas e auditoria.

-- 1. Configurações por empresa
ALTER TABLE settings ADD COLUMN IF NOT EXISTS ai_agent_key TEXT;

-- 2. Contexto do atendimento e coordenação em recovery_leads
ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS request_summary TEXT;
ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS request_message_id INTEGER REFERENCES whatsapp_messages(id) ON DELETE SET NULL;
ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS commitment TEXT;
ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS next_action TEXT;
ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS human_owner_member_id INTEGER REFERENCES company_members(id) ON DELETE SET NULL;
ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS next_action_due_at TIMESTAMP;
ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS sac_case_state TEXT DEFAULT 'aberto';
ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS context_version INTEGER DEFAULT 1;
ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS context_updated_by TEXT;
ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS bot_control_version INTEGER DEFAULT 1;

-- 3. Rastreamento e idempotência de envio em whatsapp_messages
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS send_state TEXT DEFAULT 'accepted';
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS client_request_id TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS send_error TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_company_client_req_unique
ON whatsapp_messages (company_id, client_request_id)
WHERE client_request_id IS NOT NULL;

-- 4. Notas internas datadas
CREATE TABLE IF NOT EXISTS sac_internal_notes (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES recovery_leads(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL DEFAULT 'human',
  author_id TEXT,
  author_name TEXT,
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS sac_internal_notes_company_lead_created_idx
ON sac_internal_notes (company_id, lead_id, created_at);

-- 5. Respostas aprovadas do compositor
CREATE TABLE IF NOT EXISTS sac_approved_replies (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  shortcut TEXT,
  body TEXT NOT NULL,
  variables JSONB,
  approval_state TEXT NOT NULL DEFAULT 'approved',
  version INTEGER NOT NULL DEFAULT 1,
  approved_by TEXT,
  approved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sac_approved_replies_company_state_idx
ON sac_approved_replies (company_id, approval_state);

CREATE UNIQUE INDEX IF NOT EXISTS sac_approved_replies_company_shortcut_unique
ON sac_approved_replies (company_id, shortcut)
WHERE shortcut IS NOT NULL;

-- 6. Pendências internas das 3 regras prontas
CREATE TABLE IF NOT EXISTS sac_pending_items (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES recovery_leads(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  human_owner_member_id INTEGER REFERENCES company_members(id) ON DELETE SET NULL,
  due_at TIMESTAMP,
  state TEXT NOT NULL DEFAULT 'pendente',
  created_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS sac_pending_items_company_lead_rule_source_unique
ON sac_pending_items (company_id, lead_id, rule_type, source_key);

CREATE INDEX IF NOT EXISTS sac_pending_items_company_state_due_idx
ON sac_pending_items (company_id, state, due_at);

-- 7. Eventos de auditoria do atendimento
CREATE TABLE IF NOT EXISTS sac_audit_events (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES recovery_leads(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  reference_type TEXT,
  reference_id TEXT,
  payload JSONB,
  occurred_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sac_audit_events_company_lead_occurred_idx
ON sac_audit_events (company_id, lead_id, occurred_at);
