-- Escopo opcional de canal para tags de lead. NULL representa uma tag geral.
-- O COALESCE impede que duas tags gerais iguais coexistam, pois um índice
-- único comum considera NULL distinto de NULL.

ALTER TABLE "lead_tags" ADD COLUMN IF NOT EXISTS "scope_channel" TEXT;

-- Uma tentativa anterior, depois revertida, pode ter deixado tags gerais
-- duplicadas (NULL não era protegido pelo índice antigo). Limpar o legado
-- antes de recriar o índice evita que a migração falhe e deixe o banco sem
-- a proteção correta. Mantemos a linha mais antiga, com id como desempate.
DELETE FROM "lead_tags"
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT
      "id",
      ROW_NUMBER() OVER (
        PARTITION BY "lead_id", "tag", COALESCE("scope_channel", '')
        ORDER BY "created_at" ASC NULLS LAST, "id" ASC
      ) AS "duplicate_position"
    FROM "lead_tags"
  ) AS "ranked_lead_tags"
  WHERE "duplicate_position" > 1
);

-- O mesmo nome chegou a ser usado por uma versão antiga sem COALESCE.
-- Recriar sempre garante a definição correta, independentemente do estado
-- deixado por uma execução anterior ou por uma tentativa revertida.
DROP INDEX IF EXISTS "lead_tags_lead_tag_scope_unique";
CREATE UNIQUE INDEX "lead_tags_lead_tag_scope_unique"
  ON "lead_tags" ("lead_id", "tag", COALESCE("scope_channel", ''));

DROP INDEX IF EXISTS "lead_tags_lead_tag_unique";
