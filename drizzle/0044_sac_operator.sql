-- Fase 0 do Operador SAC. Esta migration e exclusivamente aditiva e nao e
-- carregada pelo ensureSchema. Mantida somente por este arquivo: nao usar
-- db:push, pois o schema.ts legado nao inclui estas tres tabelas. IDs UUID sao gerados pelo servidor.
CREATE TABLE IF NOT EXISTS sac_operator_company_settings (
  company_id integer PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  kill_switch boolean NOT NULL DEFAULT false,
  allowed_actions jsonb NOT NULL DEFAULT '["buscar_lead","listar_etapas","listar_regras_instagram"]'::jsonb,
  link_domains jsonb NOT NULL DEFAULT '[]'::jsonb,
  stage_aliases jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_jobs_per_day integer NOT NULL DEFAULT 50,
  daily_token_budget integer NOT NULL DEFAULT 50000,
  daily_usage_date date,
  daily_jobs_reserved integer NOT NULL DEFAULT 0,
  daily_tokens_reserved integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sac_operator_company_settings_max_jobs_check CHECK (max_jobs_per_day >= 0),
  CONSTRAINT sac_operator_company_settings_token_budget_check CHECK (daily_token_budget >= 0)
);

CREATE TABLE IF NOT EXISTS sac_operator_jobs (
  id uuid PRIMARY KEY,
  company_id integer NOT NULL,
  requested_by_user_id text NOT NULL,
  role text NOT NULL,
  request_text text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pendente',
  waiting_reason text,
  plan_json jsonb,
  plan_hash text,
  approved_plan_hash text,
  confirmed_by text,
  confirmed_at timestamptz,
  confirmation_expires_at timestamptz,
  result_text text,
  result_json jsonb,
  error_code text,
  reserved_tokens integer NOT NULL DEFAULT 0,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT sac_operator_jobs_status_check CHECK (status IN ('pendente', 'em_execucao', 'aguardando_confirmacao', 'concluido', 'falhou', 'cancelado')),
  CONSTRAINT sac_operator_jobs_request_length_check CHECK (char_length(request_text) <= 4000),
  CONSTRAINT sac_operator_jobs_company_idempotency_unique UNIQUE (company_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS sac_operator_jobs_company_created_idx
  ON sac_operator_jobs (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sac_operator_jobs_company_status_idx
  ON sac_operator_jobs (company_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS sac_operator_actions (
  id uuid PRIMARY KEY,
  company_id integer NOT NULL,
  job_id uuid NOT NULL,
  ordinal integer NOT NULL,
  action_type text NOT NULL,
  target_id text,
  request_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  before_snapshot jsonb,
  after_snapshot jsonb,
  status text NOT NULL DEFAULT 'pendente',
  idempotency_key text NOT NULL,
  applied_at timestamptz,
  CONSTRAINT sac_operator_actions_status_check CHECK (status IN ('pendente', 'em_execucao', 'aguardando_confirmacao', 'concluido', 'falhou', 'cancelado')),
  CONSTRAINT sac_operator_actions_company_idempotency_unique UNIQUE (company_id, idempotency_key),
  CONSTRAINT sac_operator_actions_job_ordinal_unique UNIQUE (job_id, ordinal)
);

CREATE INDEX IF NOT EXISTS sac_operator_actions_company_job_idx
  ON sac_operator_actions (company_id, job_id, ordinal);
