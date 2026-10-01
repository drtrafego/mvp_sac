-- Migration 0025: Unique constraints for company credential IDs in settings table to prevent cross-tenant message leaks
CREATE UNIQUE INDEX IF NOT EXISTS settings_meta_phone_number_id_unique ON settings (meta_phone_number_id) WHERE meta_phone_number_id IS NOT NULL AND meta_phone_number_id != '';
CREATE UNIQUE INDEX IF NOT EXISTS settings_uazapi_instance_token_unique ON settings (uazapi_instance_token) WHERE uazapi_instance_token IS NOT NULL AND uazapi_instance_token != '';
CREATE UNIQUE INDEX IF NOT EXISTS settings_instagram_account_id_unique ON settings (instagram_account_id) WHERE instagram_account_id IS NOT NULL AND instagram_account_id != '';
CREATE UNIQUE INDEX IF NOT EXISTS settings_instagram_page_id_unique ON settings (instagram_page_id) WHERE instagram_page_id IS NOT NULL AND instagram_page_id != '';
