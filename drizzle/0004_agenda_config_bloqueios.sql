-- Migração aditiva (expand): nenhuma coluna nem tabela existente é tocada.
-- Adiciona a capacidade de configurar, no SAC, os dois gaps achados na
-- auditoria contra o painel antigo (agente-ia.casaldotrafego.com):
--
-- 1) Bloqueio de agenda por data (ex.: Dr. Lucas tira férias/congresso e a
--    agenda não pode oferecer horário nesses dias). Espelha o comando
--    `bloquear <data> [motivo]` do agenda_tools.py que roda hoje dentro do
--    container Hermes de cada bot.
--
-- 2) Grade semanal de horário de atendimento (availability_schedule em
--    settings, jsonb), espelhando o agenda_config.json que cada bot guarda
--    hoje dentro do próprio container.
--
-- IMPORTANTE: isto é só a CONFIGURAÇÃO. Nenhum bot (Dr. Lucas incluso) lê
-- daqui ainda — a integração ("o bot pergunta ao SAC antes de oferecer
-- horário") é trabalho futuro, parte da migração maior de Dr. Lucas/Gramado
-- pro SAC.
--
-- Este projeto foi versionado até aqui via self-healing schema em
-- src/lib/db/index.ts (ensureSchema), não por reconciliação de snapshot do
-- drizzle-kit generate (mesmo padrão de 0001, 0002 e 0003). Este arquivo é
-- aditivo e independente, seguro de aplicar sozinho com psql/drizzle-kit push.
-- Os mesmos comandos (com ADD COLUMN/CREATE TABLE/INDEX IF NOT EXISTS) já
-- estão espelhados em ensureSchema() para autoaplicar em produção no boot.

ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "availability_schedule" jsonb;

CREATE TABLE IF NOT EXISTS "agenda_blocked_dates" (
  "id" SERIAL PRIMARY KEY,
  "company_id" INTEGER NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "date" DATE NOT NULL,
  "reason" TEXT,
  "created_at" TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "agenda_blocked_dates_company_date_unique"
ON "agenda_blocked_dates" ("company_id", "date");
