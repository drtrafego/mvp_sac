-- Migração aditiva (expand): coluna nova, nullable, sem default obrigatório,
-- sem travar a tabela recovery_leads em produção (mesmo padrão de
-- 0001_add_first_contact_at e 0006_recovery_leads_bot_paused_all).
--
-- Tags estruturadas de mineração para classificação/segmentação de leads
-- (pedido do Gastão, dono do produto). Forma do JSON, todos os campos
-- opcionais (dado real tem lacuna):
--   { origem?, nicho?, temperatura?, statusRelacionamento? }
--
-- origem e temperatura vêm do minerador (via Agents DB intermediário,
-- sync-agents.ts); nicho foi promovido do nível da mineração pro lead;
-- statusRelacionamento é campo NOVO que o SAC introduz, sem cobertura ainda
-- no minerador (hoje só 8,6% fragmentado por campanha).

ALTER TABLE "recovery_leads" ADD COLUMN IF NOT EXISTS "mining_tags" jsonb;
