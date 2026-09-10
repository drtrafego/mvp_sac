-- Migration aditiva para PostgreSQL 15+.
-- Substitua literalmente <schema> pelo schema do cliente antes de revisar/aplicar.
-- Este arquivo NAO deve ser executado com o placeholder presente.
BEGIN;

-- Chaves compostas permitem que todas as FKs abaixo validem o tenant.
ALTER TABLE <schema>.leads
  ADD CONSTRAINT leads_org_id_multicanal_uq UNIQUE (organization_id, id);
ALTER TABLE <schema>.leads
  ADD COLUMN merged_into_lead_id uuid,
  ADD CONSTRAINT leads_merge_target_fk
    FOREIGN KEY (organization_id, merged_into_lead_id)
    REFERENCES <schema>.leads (organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT leads_cannot_merge_into_self CHECK (merged_into_lead_id IS NULL OR merged_into_lead_id <> id);
ALTER TABLE <schema>.pipeline_stages
  ADD CONSTRAINT pipeline_stages_org_id_multicanal_uq UNIQUE (organization_id, id);
ALTER TABLE <schema>.activities
  ADD CONSTRAINT activities_org_id_multicanal_uq UNIQUE (organization_id, id);

CREATE TABLE <schema>.contact_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  lead_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'instagram', 'email')),
  channel_account_id text NOT NULL DEFAULT '',
  external_id text NOT NULL,
  normalized_value text,
  verified_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_identities_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT contact_identities_lead_fk FOREIGN KEY (organization_id, lead_id)
    REFERENCES <schema>.leads (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT contact_identities_external_not_blank CHECK (btrim(external_id) <> '')
);

CREATE UNIQUE INDEX contact_identities_external_uq
  ON <schema>.contact_identities
  (organization_id, channel, channel_account_id, external_id);
CREATE INDEX contact_identities_lead_idx
  ON <schema>.contact_identities (organization_id, lead_id);
CREATE INDEX contact_identities_normalized_idx
  ON <schema>.contact_identities (organization_id, normalized_value)
  WHERE normalized_value IS NOT NULL;

-- Pontos de contato enriquecidos são separados das identidades de transporte.
-- A unicidade impede apropriação silenciosa por outro lead; merge exige comando explícito.
CREATE TABLE <schema>.contact_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  lead_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('email', 'phone', 'instagram')),
  value text NOT NULL,
  normalized_value text NOT NULL,
  source text NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_points_lead_fk FOREIGN KEY (organization_id, lead_id)
    REFERENCES <schema>.leads (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT contact_points_value_not_blank CHECK (btrim(normalized_value) <> ''),
  CONSTRAINT contact_points_source_not_blank CHECK (btrim(source) <> ''),
  CONSTRAINT contact_points_identity_uq UNIQUE (organization_id, kind, normalized_value)
);
CREATE INDEX contact_points_lead_idx ON <schema>.contact_points (organization_id, lead_id);

CREATE TABLE <schema>.contact_profile_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  lead_id uuid NOT NULL,
  field_name text NOT NULL,
  value jsonb NOT NULL,
  source text NOT NULL,
  confidence numeric(4,3) NOT NULL DEFAULT 1 CHECK (confidence BETWEEN 0 AND 1),
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_profile_fields_lead_fk FOREIGN KEY (organization_id, lead_id)
    REFERENCES <schema>.leads (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT contact_profile_fields_name_not_blank CHECK (btrim(field_name) <> ''),
  CONSTRAINT contact_profile_fields_source_not_blank CHECK (btrim(source) <> ''),
  CONSTRAINT contact_profile_fields_fact_uq UNIQUE (organization_id, lead_id, field_name, source)
);
CREATE INDEX contact_profile_fields_lead_idx
  ON <schema>.contact_profile_fields (organization_id, lead_id, field_name);

CREATE TABLE <schema>.contact_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_tags_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT contact_tags_name_uq UNIQUE (organization_id, name),
  CONSTRAINT contact_tags_org_id_uq UNIQUE (organization_id, id)
);

CREATE TABLE <schema>.contact_tag_assignments (
  organization_id text NOT NULL,
  lead_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, lead_id, tag_id),
  CONSTRAINT contact_tag_assignments_lead_fk FOREIGN KEY (organization_id, lead_id)
    REFERENCES <schema>.leads (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT contact_tag_assignments_tag_fk FOREIGN KEY (organization_id, tag_id)
    REFERENCES <schema>.contact_tags (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT contact_tag_assignments_source_not_blank CHECK (btrim(source) <> '')
);

CREATE TABLE <schema>.contact_merges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  source_lead_id uuid NOT NULL,
  target_lead_id uuid NOT NULL,
  actor text NOT NULL,
  reason text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_merges_source_fk FOREIGN KEY (organization_id, source_lead_id)
    REFERENCES <schema>.leads (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT contact_merges_target_fk FOREIGN KEY (organization_id, target_lead_id)
    REFERENCES <schema>.leads (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT contact_merges_distinct CHECK (source_lead_id <> target_lead_id),
  CONSTRAINT contact_merges_actor_not_blank CHECK (btrim(actor) <> ''),
  CONSTRAINT contact_merges_reason_not_blank CHECK (btrim(reason) <> '')
);
CREATE UNIQUE INDEX contact_merges_source_once_uq
  ON <schema>.contact_merges (organization_id, source_lead_id);

CREATE TABLE <schema>.conversation_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  lead_id uuid NOT NULL,
  identity_id uuid,
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'instagram', 'email')),
  channel_account_id text NOT NULL DEFAULT '',
  external_thread_id text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'closed')),
  first_message_at timestamptz,
  last_message_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_threads_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT conversation_threads_lead_fk FOREIGN KEY (organization_id, lead_id)
    REFERENCES <schema>.leads (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT conversation_threads_identity_fk FOREIGN KEY (organization_id, identity_id)
    REFERENCES <schema>.contact_identities (organization_id, id) ON DELETE SET NULL,
  CONSTRAINT conversation_threads_external_not_blank CHECK (btrim(external_thread_id) <> ''),
  CONSTRAINT conversation_threads_time_order CHECK (
    first_message_at IS NULL OR last_message_at IS NULL OR first_message_at <= last_message_at
  )
);

CREATE UNIQUE INDEX conversation_threads_external_uq
  ON <schema>.conversation_threads
  (organization_id, channel, channel_account_id, external_thread_id);
CREATE INDEX conversation_threads_lead_idx
  ON <schema>.conversation_threads (organization_id, lead_id, last_message_at DESC);

CREATE TABLE <schema>.conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  thread_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  external_message_id text,
  dedupe_key text,
  body text,
  subject text,
  status text NOT NULL DEFAULT 'received',
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_messages_thread_fk FOREIGN KEY (organization_id, thread_id)
    REFERENCES <schema>.conversation_threads (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT conversation_messages_has_payload CHECK (
    body IS NOT NULL OR subject IS NOT NULL OR metadata <> '{}'::jsonb
  )
);

CREATE UNIQUE INDEX conversation_messages_external_uq
  ON <schema>.conversation_messages (organization_id, thread_id, external_message_id)
  WHERE external_message_id IS NOT NULL;
CREATE UNIQUE INDEX conversation_messages_dedupe_uq
  ON <schema>.conversation_messages (organization_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX conversation_messages_timeline_idx
  ON <schema>.conversation_messages (organization_id, thread_id, occurred_at, id);

-- Histórico de atribuição: nunca se sobrescreve uma origem antiga.
CREATE TABLE <schema>.contact_origins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  lead_id uuid NOT NULL,
  source_type text NOT NULL,
  source_id text,
  campaign_id text,
  medium text,
  content text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_origins_lead_fk FOREIGN KEY (organization_id, lead_id)
    REFERENCES <schema>.leads (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT contact_origins_source_not_blank CHECK (btrim(source_type) <> '')
);
CREATE INDEX contact_origins_lead_timeline_idx
  ON <schema>.contact_origins (organization_id, lead_id, captured_at, id);

-- Event log comum a canal, origem e pipeline. actor_kind distingue pessoa de automação.
CREATE TABLE <schema>.multichannel_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  lead_id uuid,
  thread_id uuid,
  activity_id uuid,
  event_type text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'automation', 'system')),
  actor_id text,
  idempotency_key text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT multichannel_events_lead_fk FOREIGN KEY (organization_id, lead_id)
    REFERENCES <schema>.leads (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT multichannel_events_thread_fk FOREIGN KEY (organization_id, thread_id)
    REFERENCES <schema>.conversation_threads (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT multichannel_events_activity_fk FOREIGN KEY (organization_id, activity_id)
    REFERENCES <schema>.activities (organization_id, id) ON DELETE SET NULL (activity_id),
  CONSTRAINT multichannel_events_type_not_blank CHECK (btrim(event_type) <> '')
);
CREATE UNIQUE INDEX multichannel_events_idempotency_uq
  ON <schema>.multichannel_events (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX multichannel_events_lead_timeline_idx
  ON <schema>.multichannel_events (organization_id, lead_id, occurred_at, id);

CREATE TABLE <schema>.pipeline_automation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  event_type text NOT NULL,
  from_stage_id uuid,
  to_stage_id uuid NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  enabled boolean NOT NULL DEFAULT true,
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_rules_from_fk FOREIGN KEY (organization_id, from_stage_id)
    REFERENCES <schema>.pipeline_stages (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT pipeline_rules_to_fk FOREIGN KEY (organization_id, to_stage_id)
    REFERENCES <schema>.pipeline_stages (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT pipeline_rules_distinct CHECK (from_stage_id IS NULL OR from_stage_id <> to_stage_id),
  CONSTRAINT pipeline_rules_event_not_blank CHECK (btrim(event_type) <> '')
);
CREATE INDEX pipeline_rules_lookup_idx
  ON <schema>.pipeline_automation_rules (organization_id, event_type, enabled, priority);

CREATE FUNCTION <schema>.multichannel_reject_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER contact_origins_append_only
  BEFORE UPDATE OR DELETE ON <schema>.contact_origins
  FOR EACH ROW EXECUTE FUNCTION <schema>.multichannel_reject_mutation();
CREATE TRIGGER multichannel_events_append_only
  BEFORE UPDATE OR DELETE ON <schema>.multichannel_events
  FOR EACH ROW EXECUTE FUNCTION <schema>.multichannel_reject_mutation();
CREATE TRIGGER contact_merges_append_only
  BEFORE UPDATE OR DELETE ON <schema>.contact_merges
  FOR EACH ROW EXECUTE FUNCTION <schema>.multichannel_reject_mutation();

-- Movimento automático é atômico e exclusivamente progressivo por position.
-- Movimento manual continua sendo feito pela aplicação e jamais é revertido aqui.
CREATE FUNCTION <schema>.advance_pipeline_automatically(
  p_organization_id text,
  p_lead_id uuid,
  p_to_stage_id uuid,
  p_event_type text,
  p_idempotency_key text DEFAULT NULL,
  p_data jsonb DEFAULT '{}'::jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_changed boolean := false;
  v_from_stage uuid;
BEGIN
  SELECT l.pipeline_stage_id INTO v_from_stage
  FROM <schema>.leads l
  WHERE l.organization_id = p_organization_id AND l.id = p_lead_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'lead inexistente no tenant'; END IF;

  UPDATE <schema>.leads l
     SET pipeline_stage_id = target.id, updated_at = now()
    FROM <schema>.pipeline_stages target
    LEFT JOIN <schema>.pipeline_stages current
      ON current.organization_id = p_organization_id AND current.id = v_from_stage
   WHERE l.organization_id = p_organization_id
     AND l.id = p_lead_id
     AND target.organization_id = p_organization_id
     AND target.id = p_to_stage_id
     AND (current.id IS NULL OR target.position > current.position)
  RETURNING true INTO v_changed;

  IF coalesce(v_changed, false) THEN
    INSERT INTO <schema>.multichannel_events
      (organization_id, lead_id, event_type, actor_kind, idempotency_key, data)
    VALUES
      (p_organization_id, p_lead_id, 'pipeline.advanced', 'automation',
       p_idempotency_key,
       jsonb_build_object('trigger_event', p_event_type, 'from_stage_id', v_from_stage,
                          'to_stage_id', p_to_stage_id) || coalesce(p_data, '{}'::jsonb))
    ON CONFLICT (organization_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL DO NOTHING;
  END IF;

  RETURN coalesce(v_changed, false);
END;
$$;

COMMENT ON FUNCTION <schema>.advance_pipeline_automatically(text, uuid, uuid, text, text, jsonb)
  IS 'Só avança para position maior; não desfaz movimento manual nem cruza organization_id.';

COMMIT;
