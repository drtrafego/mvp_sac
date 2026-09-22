-- Migração ADITIVA (expand): agenda_blocked_dates ganha colunas novas pra
-- refletir a origem de cada bloqueio (22/09/2026, feature "Agenda reflete o
-- Google Calendar real do Dr. Lucas"). Nenhuma coluna existente é tocada,
-- nenhum dado é apagado.
--
-- source: 'manual' (padrão, comportamento de hoje preservado) |
--   'google_calendar' (evento de dia inteiro lido do Calendar) |
--   'bot_bloqueios' (gravado pelo bot Hermes via WhatsApp, feature paralela) |
--   'google_calendar+bot_bloqueios' (as duas fontes bloquearam a mesma data)
-- external_ref: id do evento do Google, só quando source inclui 'google_calendar'.
-- synced_at: última confirmação por uma fonte EXTERNA; null pra 'manual'.
--
-- bot_reason / google_reason (fix de QA, bug ALTO, 22/09/2026): reason
-- deixou de ser concatenado/sobrescrito direto (2ª sync sobre o mesmo evento
-- apagava a parte do bot). bot_reason guarda só o texto vindo do bot,
-- google_reason só o texto vindo do Google; reason vira campo calculado a
-- partir dos dois a cada escrita. Ver comentário completo em
-- src/lib/db/schema.ts e o upsert em src/lib/google-calendar-sync.ts
-- (inclui fallback de compatibilidade com o script Hermes, fora deste repo,
-- que ainda escreve direto em `reason`).
--
-- ATENÇÃO: esta migration .sql é só documental. O mecanismo REAL que aplica
-- schema em produção é ensureSchema() em src/lib/db/index.ts (ALTER TABLE
-- ... ADD COLUMN IF NOT EXISTS) — foi lá que as colunas abaixo também
-- entraram. Rodar só esta migration sem o ensureSchema correspondente NÃO
-- basta em produção (achado crítico da madrugada de 22/09/2026, mesmo bug
-- que atingiu recovery_leads antes).

ALTER TABLE agenda_blocked_dates ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE agenda_blocked_dates ADD COLUMN IF NOT EXISTS external_ref text;
ALTER TABLE agenda_blocked_dates ADD COLUMN IF NOT EXISTS synced_at timestamp;
ALTER TABLE agenda_blocked_dates ADD COLUMN IF NOT EXISTS bot_reason text;
ALTER TABLE agenda_blocked_dates ADD COLUMN IF NOT EXISTS google_reason text;
