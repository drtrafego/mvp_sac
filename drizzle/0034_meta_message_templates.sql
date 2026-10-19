CREATE TABLE IF NOT EXISTS meta_message_templates (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'pt_BR',
  category TEXT NOT NULL,
  components JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT | SUBMITTING | PENDING | APPROVED | REJECTED | FAILED
  meta_template_id TEXT,
  rejection_reason TEXT,
  last_meta_response JSONB,
  request_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  submitted_by TEXT,
  submitted_at TIMESTAMP,
  synced_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS meta_message_templates_company_name_language_unique ON meta_message_templates(company_id, name, language);
CREATE INDEX IF NOT EXISTS meta_message_templates_company_status_updated_idx ON meta_message_templates(company_id, status, updated_at);
