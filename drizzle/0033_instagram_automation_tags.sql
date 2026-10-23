ALTER TABLE instagram_comment_automations
  ADD COLUMN IF NOT EXISTS auto_tag text;

CREATE TABLE IF NOT EXISTS instagram_inbound_tag_rules (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('direct', 'story_reply')),
  keywords text,
  match_type text NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains', 'exact', 'any')),
  tag text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS instagram_inbound_tag_rules_company_trigger_idx
  ON instagram_inbound_tag_rules (company_id, trigger);
