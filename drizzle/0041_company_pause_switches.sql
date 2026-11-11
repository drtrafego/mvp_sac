-- Chave persistente de pausa do bot por empresa e escopo (all | whatsapp |
-- instagram | email). Aditivo e idempotente; o mesmo DDL roda em
-- ensureSchema (src/lib/db/index.ts) no primeiro acesso ao banco.
-- Reverter: DROP TABLE company_pause_switches; (o código volta a depender só
-- de recovery_leads.bot_paused; nenhuma coluna existente é alterada).
CREATE TABLE IF NOT EXISTS company_pause_switches (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  paused_at TIMESTAMP,
  paused_by TEXT,
  reason TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS company_pause_switches_company_scope_unique
  ON company_pause_switches (company_id, scope);
