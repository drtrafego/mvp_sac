-- Migração aditiva (expand): amplia o índice único parcial existente
-- recovery_leads_chat_company_phone_unique para cobrir também
-- platform = 'import_planilha' (importação de leads por planilha / disparo em massa,
-- ver src/app/api/leads/import/route.ts).
--
-- Corrige brecha real de concorrência encontrada em auditoria (01/10/2026):
-- duas importações concorrentes com o mesmo telefone podiam criar 2 leads distintos
-- para a mesma pessoa porque o índice só cobria 'instagram', 'sac' e 'hermes'.
--
-- Não é possível ALTER a condição WHERE de um índice existente: precisa
-- DROP + CREATE. Nenhuma coluna nem dado é tocado.
--
-- ═══════════════════════════════════════════════════════════════════════
-- PRÉ-REQUISITO — se já existir phone duplicado para o mesmo company_id
-- entre leads com platform IN ('instagram', 'sac', 'hermes', 'import_planilha'):
--
--   SELECT company_id, phone, count(*)
--   FROM recovery_leads
--   WHERE platform IN ('instagram', 'sac', 'hermes', 'import_planilha')
--   GROUP BY company_id, phone
--   HAVING count(*) > 1;
-- ═══════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS "recovery_leads_chat_company_phone_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "recovery_leads_chat_company_phone_unique"
ON "recovery_leads" ("company_id", "phone")
WHERE "platform" IN ('instagram', 'sac', 'hermes', 'import_planilha');
