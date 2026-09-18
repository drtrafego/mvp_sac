-- Migração aditiva (expand): coluna nova, nullable, sem default forçado.
-- Não bloqueia a tabela recovery_leads e não quebra nenhuma leitura existente.
--
-- Decisão de negócio: um lead só conta como "abordado" depois que uma mensagem
-- REAL (inbound ou outbound) foi trocada com ele. first_contact_at fica nulo
-- até esse momento. O dashboard e a página de origens passam a excluir
-- first_contact_at IS NULL das contagens principais (Leads Captados / Total
-- de Contatos), mostrando esse número num card separado.
--
-- Esta tabela já existe em produção com dezenas de colunas que este arquivo de
-- migração base (0000_fantastic_mimic.sql) não reflete: o projeto até aqui foi
-- versionado via `drizzle-kit push` direto (ver package.json). Por isso este
-- arquivo é aditivo e independente, seguro de aplicar com `psql`/`drizzle-kit push`
-- sem tentar reconciliar o snapshot inteiro.

ALTER TABLE "recovery_leads" ADD COLUMN IF NOT EXISTS "first_contact_at" timestamp;

-- Backfill: todo lead que já trocou pelo menos uma mensagem de verdade
-- (whatsapp_messages) recebe a data da primeira mensagem retroativamente.
-- Lead sem nenhuma mensagem continua com first_contact_at nulo (nunca abordado).
UPDATE "recovery_leads" rl
SET "first_contact_at" = wm.min_created
FROM (
  SELECT lead_id, min(created_at) AS min_created
  FROM "whatsapp_messages"
  WHERE lead_id IS NOT NULL
  GROUP BY lead_id
) wm
WHERE rl.id = wm.lead_id
  AND rl."first_contact_at" IS NULL;
