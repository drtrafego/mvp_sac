-- Credencial por empresa para o worker publicador, desacoplada dos agentes pessoais.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS agent_publicador_api_key text;
