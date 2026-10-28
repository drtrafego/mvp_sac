-- Saúde/Funcionalidades do SAC por empresa.
-- A checagem só faz leituras seguras; incidentes preservam abertura e recuperação.

CREATE TABLE IF NOT EXISTS sac_health_checks (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  critical BOOLEAN NOT NULL DEFAULT FALSE,
  configured BOOLEAN NOT NULL DEFAULT FALSE,
  reason TEXT NOT NULL,
  latency_ms INTEGER,
  status_code INTEGER,
  checked_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, feature_key)
);

CREATE INDEX IF NOT EXISTS sac_health_checks_company_checked_idx
  ON sac_health_checks (company_id, checked_at);

CREATE TABLE IF NOT EXISTS sac_health_incidents (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL,
  label TEXT NOT NULL,
  severity TEXT NOT NULL,
  reason TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  is_open BOOLEAN NOT NULL DEFAULT TRUE,
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  recovered_at TIMESTAMP,
  last_check_id INTEGER,
  alert_sent_at TIMESTAMP,
  next_alert_at TIMESTAMP,
  recovery_alert_sent_at TIMESTAMP,
  last_alert_error TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS sac_health_incidents_open_feature_unique
  ON sac_health_incidents (company_id, feature_key) WHERE is_open = TRUE;
CREATE INDEX IF NOT EXISTS sac_health_incidents_company_started_idx
  ON sac_health_incidents (company_id, started_at);
