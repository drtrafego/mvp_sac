-- Identificadores de Lead Ads que pertencem ao registro do lead e à auditoria
-- da origem. Não são tags e não autorizam edição manual da origem.
ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS meta_form_id TEXT;
ALTER TABLE recovery_leads ADD COLUMN IF NOT EXISTS meta_leadgen_id TEXT;
