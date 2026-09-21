-- Migração aditiva (expand): índice novo, não mexe em coluna nem em dado
-- existente. Segunda camada de idempotência contra reentrega de webhook da
-- Meta (comportamento real e documentado dela, não hipotético): sem isso, o
-- mesmo evento reentregue grava duas linhas inbound iguais em
-- whatsapp_messages e o generateAndSendAiReply() dispara DUAS respostas
-- reais pro mesmo cliente pra mesma mensagem.
--
-- A primeira camada é o SELECT antes do INSERT (ver
-- src/lib/webhook-dedup.ts), que cobre o caso comum. Este índice fecha a
-- corrida entre duas requisições concorrentes que passam pelo SELECT ao
-- mesmo tempo: a segunda tentativa de INSERT esbarra na unique constraint e
-- o código trata isso como "já processado", não como erro fatal
-- (isUniqueViolation() nas três rotas de webhook).
--
-- Restrito a direction='inbound' porque external_id também aparece em
-- mensagens outbound (resposta manual do Inbox, DM de comentário, sync de
-- outros agentes), que têm semântica diferente e não devem colidir aqui.
--
-- Igual à 0001_add_first_contact_at.sql: este projeto foi versionado até
-- aqui via `drizzle-kit push` direto / self-healing schema em
-- src/lib/db/index.ts (ensureSchema), não por reconciliação de snapshot do
-- drizzle-kit generate. Este arquivo é aditivo e independente, seguro de
-- aplicar sozinho com psql/drizzle-kit push.
--
-- ⚠️ PRÉ-REQUISITO: se já existir external_id duplicado (mesmo channel, com
-- direction='inbound') em produção, este CREATE UNIQUE INDEX falha. Antes de
-- aplicar, rode:
--
--   SELECT channel, external_id, count(*)
--   FROM whatsapp_messages
--   WHERE external_id IS NOT NULL AND direction = 'inbound'
--   GROUP BY channel, external_id
--   HAVING count(*) > 1;
--
-- Se retornar linhas, resolva as duplicatas (mantendo a linha mais antiga de
-- cada grupo) antes de aplicar este índice.

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_messages_inbound_external_id_unique"
ON "whatsapp_messages" ("channel", "external_id")
WHERE "external_id" IS NOT NULL AND "direction" = 'inbound';
