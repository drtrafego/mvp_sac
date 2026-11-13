-- Comentário e Direct de uma regra "both" disputam a mesma entrega por pessoa.
-- Aplique antes do deploy que passa a gravar dedupe_scope.
ALTER TABLE instagram_comment_logs
  ADD COLUMN IF NOT EXISTS dedupe_scope TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS instagram_comment_logs_both_rule_user_unique
  ON instagram_comment_logs (automation_id, commenter_id)
  WHERE dedupe_scope = 'both';
