-- Marca nomes de bot escolhidos manualmente em Configurações. Quando true,
-- sync-agents.ts preserva o valor de agent_display_name em vez de restaurar o
-- nome vindo do Agents DB.
--
-- Esta migration é documental; ensureSchema() em src/lib/db/index.ts aplica a
-- alteração no mecanismo de deploy usado pelo projeto.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS agent_display_name_manual boolean NOT NULL DEFAULT false;
