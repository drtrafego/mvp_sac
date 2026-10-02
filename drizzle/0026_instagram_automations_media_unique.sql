-- Migration 0026: Unique media automations per company to make ensure-for-media idempotent under concurrent requests
CREATE UNIQUE INDEX IF NOT EXISTS instagram_comment_automations_company_media_unique ON instagram_comment_automations (company_id, media_id) WHERE media_id IS NOT NULL AND media_id != '';
