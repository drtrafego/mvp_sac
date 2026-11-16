-- Executor externo: somente estruturas novas, sem dependências do schema legado.
CREATE TABLE IF NOT EXISTS sac_operator_executors (
  id uuid PRIMARY KEY,
  nome text NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  token_prefixo text NOT NULL,
  empresas_permitidas jsonb NOT NULL CHECK (jsonb_typeof(empresas_permitidas) = 'array'),
  revogado_em timestamptz,
  substitui_id uuid,
  ultimo_contato_em timestamptz,
  estado_informado text,
  motivo text,
  versao text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sac_operator_queue (
  job_id uuid PRIMARY KEY,
  company_id integer NOT NULL,
  estado text NOT NULL DEFAULT 'na_fila' CHECK (estado IN ('na_fila','reclamado','aplicando','entregue','falhou','expirado','cancelado')),
  tentativas integer NOT NULL DEFAULT 0,
  max_tentativas integer NOT NULL DEFAULT 2 CHECK (max_tentativas BETWEEN 1 AND 2),
  disponivel_em timestamptz NOT NULL DEFAULT now(),
  expira_em timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
  executor_id uuid,
  lease_epoch integer NOT NULL DEFAULT 0,
  lease_token_hash char(64),
  lease_expira_em timestamptz,
  heartbeat_em timestamptz,
  reclamado_em timestamptz,
  concluido_em timestamptz,
  erro_codigo text,
  modelo text,
  tokens_entrada integer NOT NULL DEFAULT 0,
  tokens_cache integer NOT NULL DEFAULT 0,
  tokens_saida integer NOT NULL DEFAULT 0,
  duracao_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sac_operator_queue_ready_idx ON sac_operator_queue (disponivel_em, created_at) WHERE estado = 'na_fila';
CREATE UNIQUE INDEX IF NOT EXISTS sac_operator_queue_company_active_idx ON sac_operator_queue (company_id) WHERE estado IN ('reclamado','aplicando');
CREATE INDEX IF NOT EXISTS sac_operator_queue_company_state_idx ON sac_operator_queue (company_id, estado);
CREATE INDEX IF NOT EXISTS sac_operator_queue_lease_idx ON sac_operator_queue (lease_expira_em) WHERE estado = 'reclamado';
CREATE TABLE IF NOT EXISTS sac_operator_job_privados (
  job_id uuid PRIMARY KEY,
  company_id integer NOT NULL,
  marcadores jsonb NOT NULL,
  texto_original text NOT NULL CHECK (char_length(texto_original) <= 4000),
  ator_nome text NOT NULL,
  empresa_slug text NOT NULL,
  admin_origem text NOT NULL CHECK (admin_origem IN ('membro','dono','plataforma')),
  apagar_apos timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
