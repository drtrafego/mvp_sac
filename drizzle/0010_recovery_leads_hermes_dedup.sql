-- Migração aditiva (expand): amplia o índice único parcial existente
-- recovery_leads_chat_company_phone_unique para cobrir também
-- platform = 'hermes' (webhook de conversão do Hermes: reserva/agendamento
-- confirmado por bot no WhatsApp, ver
-- src/app/api/webhooks/hermes/[slug]/conversion/route.ts).
--
-- Corrige achado CRÍTICO do QA (22/09/2026) na revisão do webhook de
-- conversão do Hermes: o handler fazia SELECT-então-INSERT sem proteção
-- alguma pra platform='hermes' (o índice criado em
-- 0003_recovery_leads_dedup_and_whatsapp_scope.sql só cobria
-- 'instagram'/'sac'). QA reproduziu ao vivo: 2 requisições concorrentes com
-- o mesmo telefone novo → 2 leads criados para o mesmo cliente.
--
-- Índice PARCIAL, mesmo padrão de 0003: continua NÃO afetando os webhooks de
-- VENDA (hotmart/greenn/zouti/kiwify), que legitimamente criam múltiplas
-- linhas para o mesmo company_id+phone (uma por transação, protegido por
-- recovery_leads_txn_dedup_unique).
--
-- Não é possível ALTER a condição WHERE de um índice existente: precisa
-- DROP + CREATE. Nenhuma coluna nem dado é tocado.
--
-- Este projeto usa self-healing schema via ensureSchema() em
-- src/lib/db/index.ts. A migration SQL é apenas documental e mantém a
-- sequência das alterações de schema explícita no repositório (mesmo padrão
-- de 0001/0002/0003).
--
-- ═══════════════════════════════════════════════════════════════════════
-- PRÉ-REQUISITO — se já existir phone duplicado para o mesmo company_id
-- entre leads com platform='hermes' (não deveria, é fluxo novo sem tráfego
-- em produção ainda), o CREATE UNIQUE INDEX abaixo falha. Rode ANTES de
-- aplicar:
--
--   SELECT company_id, phone, count(*)
--   FROM recovery_leads
--   WHERE platform = 'hermes'
--   GROUP BY company_id, phone
--   HAVING count(*) > 1;
--
-- Se retornar linhas: escolha o lead "vencedor" (o mais antigo), migre
-- meta_conversion_events.lead_id e whatsapp_messages.lead_id dos leads
-- "perdedores" pro vencedor, apague os perdedores, rode a query de novo até
-- vir vazia.
-- ═══════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS "recovery_leads_chat_company_phone_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "recovery_leads_chat_company_phone_unique"
ON "recovery_leads" ("company_id", "phone")
WHERE "platform" IN ('instagram', 'sac', 'hermes');
