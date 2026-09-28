-- Escopo opcional de canal para tags de lead. NULL representa uma tag geral.
-- O COALESCE impede que duas tags gerais iguais coexistam, pois um índice
-- único comum considera NULL distinto de NULL.

ALTER TABLE "lead_tags" ADD COLUMN IF NOT EXISTS "scope_channel" TEXT;

-- O mesmo nome chegou a ser usado por uma versão antiga sem COALESCE.
-- Recriar sempre garante a definição correta, independentemente do estado
-- deixado por uma execução anterior ou por uma tentativa revertida.
DROP INDEX IF EXISTS "lead_tags_lead_tag_scope_unique";
CREATE UNIQUE INDEX "lead_tags_lead_tag_scope_unique"
  ON "lead_tags" ("lead_id", "tag", COALESCE("scope_channel", ''));

DROP INDEX IF EXISTS "lead_tags_lead_tag_unique";
