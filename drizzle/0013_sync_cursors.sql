-- Migração aditiva (expand): tabela de cursores do sync Agents/CRM.
--
-- Contexto do bug corrigido em 22/09/2026: sync-agents.ts buscava sempre as
-- 300 linhas mais recentes de conversas/outreach/leads. Como o cron roda a
-- função inteira a cada 10 minutos, uma fonte com mais de 300 linhas ficava
-- presa para sempre na janela recente e o histórico antigo nunca entrava.
--
-- A tabela guarda uma linha por empresa + fonte + schema/chave da fonte:
--   newest_synced_at/id: fronteira para buscar novidades.
--   backfill_before_at/id: fronteira para andar para trás no histórico.
--
-- ATENÇÃO: esta migration .sql é documental. O mecanismo real que aplica
-- schema em produção é ensureSchema() em src/lib/db/index.ts.

CREATE TABLE IF NOT EXISTS sync_cursors (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  source_key TEXT NOT NULL,
  newest_synced_at TIMESTAMP,
  newest_synced_id TEXT,
  backfill_before_at TIMESTAMP,
  backfill_before_id TEXT,
  last_run_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS sync_cursors_company_source_key_unique
  ON sync_cursors (company_id, source, source_key);

CREATE INDEX IF NOT EXISTS sync_cursors_source_lookup_idx
  ON sync_cursors (source, source_key);
