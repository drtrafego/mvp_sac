-- Gatilho de automação por comentário, Direct ou ambos. Aplique esta migration
-- antes do deploy que passa a ler trigger_type.
ALTER TABLE instagram_comment_automations
  ADD COLUMN IF NOT EXISTS trigger_type TEXT NOT NULL DEFAULT 'comment';

-- Regras antigas recebem o default comment e, portanto, não passam a responder
-- Direct sem uma edição explícita no painel.
UPDATE instagram_comment_automations
SET trigger_type = 'comment'
WHERE trigger_type IS NULL OR trigger_type NOT IN ('comment', 'direct', 'both');

CREATE UNIQUE INDEX IF NOT EXISTS instagram_comment_logs_direct_rule_user_unique
  ON instagram_comment_logs (automation_id, commenter_id)
  WHERE media_id IS NULL;
