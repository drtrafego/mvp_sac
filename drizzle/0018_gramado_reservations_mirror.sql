-- Migração aditiva/documental do espelho operacional de reservas do
-- Gramado Plazza. Em produção a mesma DDL é aplicada por ensureSchema().

CREATE TABLE IF NOT EXISTS gramado_reservations (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES recovery_leads(id) ON DELETE SET NULL,
  reserva_id TEXT NOT NULL,
  phone_norm TEXT,
  data DATE NOT NULL,
  horario_reservado TIME,
  horario_chegada TIME,
  pessoas INTEGER,
  valor_total NUMERIC(12,2),
  status TEXT NOT NULL,
  observacoes TEXT,
  mesas_unificadas BOOLEAN,
  atualizado_em TIMESTAMPTZ,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS gramado_reservations_company_reserva_unique
  ON gramado_reservations (company_id, reserva_id);

CREATE INDEX IF NOT EXISTS gramado_reservations_lead_idx
  ON gramado_reservations (company_id, lead_id);

CREATE INDEX IF NOT EXISTS gramado_reservations_phone_idx
  ON gramado_reservations (company_id, phone_norm);
