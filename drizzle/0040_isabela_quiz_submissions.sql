-- Quiz Isabela: histórico aditivo e isolado no agente isabela-fanini/bela.
-- Aplicar após o provisionamento do agente; nenhuma tabela de outros tenants é tocada.
DO $$
DECLARE v_schema text;
BEGIN
  SELECT schema_name INTO v_schema FROM public.sac_agents
    WHERE tenant_id = 'isabela-fanini' AND id = 'bela' AND status IN ('provisioned','active');
  IF v_schema IS NULL THEN RETURN; END IF;
  EXECUTE format($sql$
    CREATE TABLE IF NOT EXISTS %I.sac_quiz_isabela_submissions (
      tenant_id text NOT NULL DEFAULT 'isabela-fanini', agent_id text NOT NULL DEFAULT 'bela',
      id text NOT NULL, contact_id text NOT NULL, idempotency_key text NOT NULL,
      answers jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'object'), result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
      consent boolean NOT NULL, attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, agent_id, id), UNIQUE (tenant_id, agent_id, idempotency_key),
      FOREIGN KEY (tenant_id, agent_id, contact_id) REFERENCES %I.sac_contacts(tenant_id, agent_id, id) ON DELETE RESTRICT,
      CHECK (tenant_id = 'isabela-fanini' AND agent_id = 'bela' AND consent = true)
    )
  $sql$, v_schema, v_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS sac_quiz_isabela_contact_idx ON %I.sac_quiz_isabela_submissions (tenant_id, agent_id, contact_id, created_at DESC)', v_schema);
END $$;
