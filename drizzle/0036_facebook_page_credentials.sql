-- Separa a identidade da Página do Facebook das credenciais do Instagram Direct.
-- O identificador existente era Page ID, então é preservado com o novo nome.
ALTER TABLE settings RENAME COLUMN instagram_page_id TO facebook_page_id;
ALTER TABLE settings ADD COLUMN facebook_page_token text;
ALTER INDEX IF EXISTS settings_instagram_page_id_unique RENAME TO settings_facebook_page_id_unique;
