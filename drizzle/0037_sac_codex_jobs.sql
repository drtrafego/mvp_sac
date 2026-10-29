-- Jobs do fluxo SAC -> Hermes local -> gateway Codex -> operação allowlisted.
-- O áudio não é armazenado, apenas seu SHA-256 para auditoria e deduplicação.
CREATE TABLE IF NOT EXISTS sac_codex_jobs (
  id SERIAL PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  gateway_job_id TEXT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  input_kind TEXT NOT NULL,
  audio_sha256 TEXT,
  transcript TEXT NOT NULL,
  intent TEXT NOT NULL,
  target_text TEXT,
  media_id TEXT,
  media_url TEXT,
  context JSONB,
  status TEXT NOT NULL DEFAULT 'recebido',
  result JSONB,
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMP,
  execution_claimed_at TIMESTAMP,
  completed_at TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS sac_codex_jobs_company_idempotency_unique
  ON sac_codex_jobs (company_id, idempotency_key);
CREATE INDEX IF NOT EXISTS sac_codex_jobs_company_status_updated_idx
  ON sac_codex_jobs (company_id, status, updated_at);
