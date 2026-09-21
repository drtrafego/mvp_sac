-- Migração aditiva (expand): coluna nova, nullable com default, sem travar a
-- tabela recovery_leads em produção (mesmo padrão de 0001_add_first_contact_at).
--
-- Decisão de negócio: "Pausar tudo" (POST /api/v1/companies/:idOrSlug/pause-all)
-- pausa em massa todo lead que ainda não estava pausado. bot_paused_all marca
-- QUEM foi pausado por essa ação em massa, para diferenciar de uma pausa
-- individual feita por um humano por decisão própria (ex.: já está atendendo
-- aquele cliente na mão). "Despausar tudo" só reverte quem tem esta flag,
-- nunca a pausa individual alheia que já existia antes da ação em massa.

ALTER TABLE "recovery_leads" ADD COLUMN IF NOT EXISTS "bot_paused_all" boolean DEFAULT false;
