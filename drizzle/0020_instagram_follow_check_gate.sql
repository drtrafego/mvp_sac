-- Documental (a migração REAL roda em ensureSchema(), src/lib/db/index.ts,
-- mesmo padrão do resto do projeto — ver comentário no topo daquele
-- arquivo). Migração aditiva (expand): duas colunas nullable/com default,
-- sem travar tabela em produção.
--
-- Gate de seguidor do Instagram Comment-to-DM (24/09/2026, pedido do
-- Gastão): opt-in POR AUTOMAÇÃO. Quando require_follow_check=true, o
-- comentário com palavra-chave NÃO recebe o dmMessage direto: recebe uma
-- pergunta intermediária, e o lead fica marcado em
-- pending_follow_check_automation_id até responder. A resposta é checada de
-- verdade via Instagram User Profile API (is_user_follow_business) antes de
-- liberar o conteúdo real. Ver comentários completos em src/lib/db/schema.ts
-- (instagramCommentAutomations.requireFollowCheck e
-- recoveryLeads.pendingFollowCheckAutomationId) e
-- src/lib/instagram-comment-processor.ts (processInstagramComment e
-- handleFollowCheckReply).

ALTER TABLE "instagram_comment_automations" ADD COLUMN IF NOT EXISTS "require_follow_check" boolean DEFAULT false;
ALTER TABLE "recovery_leads" ADD COLUMN IF NOT EXISTS "pending_follow_check_automation_id" integer REFERENCES "instagram_comment_automations"("id") ON DELETE SET NULL;

-- FIX ALTO de QA (24/09/2026, 2ª rodada): sem limite de tentativas, um lead
-- que decidiu não seguir mas queria falar de outra coisa ficava sequestrado
-- no gate pra sempre. Ver comentário completo em schema.ts e
-- MAX_FOLLOW_CHECK_ATTEMPTS em src/lib/instagram-comment-processor.ts.
ALTER TABLE "recovery_leads" ADD COLUMN IF NOT EXISTS "pending_follow_check_attempts" integer DEFAULT 0;
