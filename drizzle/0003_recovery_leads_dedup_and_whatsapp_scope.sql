-- Migração aditiva (expand): dois índices únicos parciais novos/ajustados,
-- nenhuma coluna nem dado existente é tocado. Corrige dois achados do QA na
-- 2ª rodada de revisão do webhook Instagram/WhatsApp → IA:
--
-- 1) ALTO: lead duplicado sob concorrência real em recovery_leads. As rotas
--    de webhook de atendimento (Instagram Direct e WhatsApp SAC) faziam
--    SELECT por telefone e, se não achasse, INSERT — sem transação nem lock.
--    Provado ao vivo pelo QA: 10 requisições concorrentes com telefone novo
--    e mesmo mid → 6 leads distintos para o MESMO telefone, fragmentando a
--    conversa do cliente em vários cards no Inbox.
--
-- 2) MÉDIO: o índice de dedup de mensagem inbound (whatsapp_messages) estava
--    em (channel, external_id), sem company_id, enquanto a checagem em
--    código (isInboundMessageAlreadyProcessed, ver src/lib/webhook-dedup.ts)
--    já filtra por companyId + externalId + direction. Uma empresa mal
--    configurada compartilhando phone_number_id/instagram_account_id com
--    outra (cenário já visto neste projeto) podia ter uma mensagem legítima
--    descartada como "duplicada" de outra empresa.
--
-- Este projeto foi versionado até aqui via `drizzle-kit push` direto /
-- self-healing schema em src/lib/db/index.ts (ensureSchema), não por
-- reconciliação de snapshot do drizzle-kit generate (mesmo padrão de
-- 0001_add_first_contact_at.sql e 0002_whatsapp_messages_inbound_dedup.sql).
-- Este arquivo é aditivo e independente, seguro de aplicar sozinho com
-- psql/drizzle-kit push.
--
-- ═══════════════════════════════════════════════════════════════════════
-- PRÉ-REQUISITO 1 — recovery_leads (NOVO índice, tabela nunca teve isto):
-- se já existir phone duplicado para o mesmo company_id entre leads de
-- ATENDIMENTO (platform IN ('instagram','sac')), o CREATE UNIQUE INDEX
-- abaixo falha. Rode ANTES de aplicar:
--
--   SELECT company_id, phone, count(*)
--   FROM recovery_leads
--   WHERE platform IN ('instagram', 'sac')
--   GROUP BY company_id, phone
--   HAVING count(*) > 1;
--
-- Se retornar linhas: para cada grupo, decida o lead "vencedor" (sugestão: o
-- mais antigo, ou o que tem mais mensagens em whatsapp_messages), migre
-- whatsapp_messages.lead_id dos leads "perdedores" para o vencedor, e então
-- apague os leads perdedores. Rode a query de novo até vir vazia.
--
-- Restrito a platform IN ('instagram','sac') de propósito: os webhooks de
-- VENDA (hotmart/greenn/zouti/kiwify) criam MÚLTIPLAS linhas legítimas para
-- o mesmo company_id+phone (um lead por transação/evento, protegido por
-- recovery_leads_txn_dedup_unique) e não são afetados por este índice.
--
-- PRÉ-REQUISITO 2 — whatsapp_messages (índice EXISTENTE ganhando company_id):
-- se já existir external_id duplicado para o mesmo company_id+channel entre
-- mensagens inbound, o segundo CREATE UNIQUE INDEX abaixo falha. Rode ANTES
-- de aplicar:
--
--   SELECT company_id, channel, external_id, count(*)
--   FROM whatsapp_messages
--   WHERE external_id IS NOT NULL AND direction = 'inbound'
--   GROUP BY company_id, channel, external_id
--   HAVING count(*) > 1;
--
-- Se retornar linhas, resolva as duplicatas (mantendo a linha mais antiga de
-- cada grupo) antes de aplicar este índice. Não deveria haver: o índice
-- anterior (channel, external_id), sem company_id, já era mais restritivo.
-- ═══════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS "recovery_leads_chat_company_phone_unique"
ON "recovery_leads" ("company_id", "phone")
WHERE "platform" IN ('instagram', 'sac');

-- Substitui whatsapp_messages_inbound_external_id_unique (0002): mesmo par
-- channel+external_id, agora também escopado por company_id. Remove o
-- índice antigo (senão fica morto, sem proteção a mais) e cria o novo.
DROP INDEX IF EXISTS "whatsapp_messages_inbound_external_id_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_messages_inbound_company_channel_external_id_unique"
ON "whatsapp_messages" ("company_id", "channel", "external_id")
WHERE "external_id" IS NOT NULL AND "direction" = 'inbound';
