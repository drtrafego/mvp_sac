-- Rollback estrutural. Exportar dados novos antes: DROP TABLE remove dados multicanal.
-- Substitua literalmente <schema> pelo mesmo schema usado no UP.
BEGIN;

DROP FUNCTION IF EXISTS <schema>.advance_pipeline_automatically(text, uuid, uuid, text, text, jsonb);
DROP TRIGGER IF EXISTS contact_merges_append_only ON <schema>.contact_merges;
DROP TRIGGER IF EXISTS multichannel_events_append_only ON <schema>.multichannel_events;
DROP TRIGGER IF EXISTS contact_origins_append_only ON <schema>.contact_origins;
DROP FUNCTION IF EXISTS <schema>.multichannel_reject_mutation();

DROP TABLE IF EXISTS <schema>.pipeline_automation_rules;
DROP TABLE IF EXISTS <schema>.multichannel_events;
DROP TABLE IF EXISTS <schema>.contact_origins;
DROP TABLE IF EXISTS <schema>.conversation_messages;
DROP TABLE IF EXISTS <schema>.conversation_threads;
DROP TABLE IF EXISTS <schema>.contact_merges;
DROP TABLE IF EXISTS <schema>.contact_tag_assignments;
DROP TABLE IF EXISTS <schema>.contact_tags;
DROP TABLE IF EXISTS <schema>.contact_profile_fields;
DROP TABLE IF EXISTS <schema>.contact_points;
DROP TABLE IF EXISTS <schema>.contact_identities;

ALTER TABLE <schema>.leads
  DROP CONSTRAINT IF EXISTS leads_cannot_merge_into_self,
  DROP CONSTRAINT IF EXISTS leads_merge_target_fk,
  DROP COLUMN IF EXISTS merged_into_lead_id;

ALTER TABLE <schema>.pipeline_stages
  DROP CONSTRAINT IF EXISTS pipeline_stages_org_id_multicanal_uq;
ALTER TABLE <schema>.activities
  DROP CONSTRAINT IF EXISTS activities_org_id_multicanal_uq;
ALTER TABLE <schema>.leads
  DROP CONSTRAINT IF EXISTS leads_org_id_multicanal_uq;

COMMIT;
