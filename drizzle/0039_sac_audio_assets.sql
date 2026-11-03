-- Áudio explícito do painel SAC: preservação, transcrição local e auditoria.
-- O conteúdo nunca é enviado ao transporte de mensagens nem ao navegador sem
-- autenticação e escopo da empresa/lead.
CREATE TABLE IF NOT EXISTS sac_audio_assets (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES recovery_leads(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  audio_data BYTEA NOT NULL,
  status TEXT NOT NULL DEFAULT 'recebido',
  transcript TEXT,
  transcription_provider TEXT,
  error_message TEXT,
  ai_insight JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS sac_audio_assets_company_idempotency_unique
  ON sac_audio_assets (company_id, idempotency_key);
CREATE INDEX IF NOT EXISTS sac_audio_assets_company_lead_created_idx
  ON sac_audio_assets (company_id, lead_id, created_at);
