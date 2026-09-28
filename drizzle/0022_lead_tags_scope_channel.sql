-- Escopo opcional de canal para tags de lead. NULL representa uma tag geral.
-- O COALESCE impede que duas tags gerais iguais coexistam, pois um índice
-- único comum considera NULL distinto de NULL.

ALTER TABLE "lead_tags" ADD COLUMN IF NOT EXISTS "scope_channel" TEXT;

-- Criado antes da remoção do índice antigo para não abrir uma janela sem
-- proteção contra duplicatas durante a migração.
CREATE UNIQUE INDEX IF NOT EXISTS "lead_tags_lead_tag_scope_unique"
  ON "lead_tags" ("lead_id", "tag", COALESCE("scope_channel", ''));

DROP INDEX IF EXISTS "lead_tags_lead_tag_unique";
