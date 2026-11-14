-- Gatilho de resposta a Story. Somente tabelas novas; seguro para reaplicação.
-- Os FKs a companies preservam integridade e tomam lock curto nessa tabela: rode fora de pico.
CREATE TABLE IF NOT EXISTS instagram_story_automations (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  keywords text[] NOT NULL DEFAULT '{}',
  match_type text NOT NULL DEFAULT 'contains' CHECK (match_type IN ('any', 'contains', 'exact')),
  story_id text,
  dm_message text NOT NULL,
  mode text NOT NULL DEFAULT 'observe' CHECK (mode IN ('observe', 'send')),
  is_active boolean NOT NULL DEFAULT false,
  enabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS instagram_story_automations_company_created_idx
  ON instagram_story_automations(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS instagram_story_automations_active_story_idx
  ON instagram_story_automations(company_id, is_active, story_id);

CREATE TABLE IF NOT EXISTS instagram_story_deliveries (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  automation_id integer REFERENCES instagram_story_automations(id) ON DELETE SET NULL,
  sender_id text NOT NULL,
  story_id text NOT NULL,
  message_mid text,
  occurred_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('observed', 'skipped', 'reserved', 'sent', 'failed', 'unknown')),
  reason text,
  outbound_message_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS instagram_story_deliveries_company_created_idx
  ON instagram_story_deliveries(company_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS instagram_story_delivery_send_once_idx
  ON instagram_story_deliveries(company_id, sender_id, story_id)
  WHERE status IN ('reserved', 'sent', 'failed', 'unknown');
