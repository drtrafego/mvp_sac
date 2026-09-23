-- Espelho local, somente-leitura, de <schema>.agendamentos dos agentes.
-- A aplicação em produção também é garantida por ensureSchema().
CREATE TABLE IF NOT EXISTS appointment_mirror (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  native_id TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  phone_norm TEXT,
  consultation_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  origin TEXT,
  cancelled_at TIMESTAMPTZ,
  source_synced_at TIMESTAMPTZ NOT NULL,
  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS appointment_mirror_company_native_unique
  ON appointment_mirror (company_id, native_id);
CREATE INDEX IF NOT EXISTS appointment_mirror_company_phone_idx
  ON appointment_mirror (company_id, phone_norm);
CREATE INDEX IF NOT EXISTS appointment_mirror_company_date_idx
  ON appointment_mirror (company_id, consultation_at);
