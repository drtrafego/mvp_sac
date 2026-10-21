-- Google Analytics 4 Measurement Protocol events.
-- The resulting GA4 key event can then be imported into Google Ads manually.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS ga4_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS ga4_measurement_id TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS ga4_api_secret TEXT;

ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS google_click_id TEXT;
ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS google_gbraid TEXT;
ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS google_wbraid TEXT;

CREATE TABLE IF NOT EXISTS ga4_conversion_events (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES recovery_leads(id) ON DELETE SET NULL,
  event_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  measurement_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  http_status INTEGER,
  ga4_response JSONB,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  sent_at TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS ga4_conversion_events_company_event_unique
  ON ga4_conversion_events (company_id, event_id);
