-- Operador SAC, fase de ações: trava por empresa para escrita de regras e lote.
-- Somente tabela nova. Seguro para reaplicação. Não é carregada pelo ensureSchema.
CREATE TABLE IF NOT EXISTS sac_operator_locks (
  company_id integer PRIMARY KEY,
  holder uuid NOT NULL,
  locked_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
