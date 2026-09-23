-- Espelho somente leitura do horário operacional dos bots Hermes.
-- O bot continua sendo a fonte de verdade; esta tabela nunca é consumida por
-- ele e não concede ao SAC poder de alterar o atendimento real.
CREATE TABLE IF NOT EXISTS native_availability_schedules (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE UNIQUE,
  schedule JSONB NOT NULL,
  source TEXT NOT NULL,
  source_label TEXT NOT NULL,
  source_cursor TEXT NOT NULL,
  captured_at TIMESTAMP NOT NULL,
  synced_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
