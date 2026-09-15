-- Adiciona as colunas da plataforma Zouti na tabela settings.
-- Idempotente: pode rodar mais de uma vez sem erro.
-- Aplicar no Neon (psql, Drizzle Studio ou painel SQL) OU rodar `pnpm db:push`.

ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "zouti_webhook_token" text;
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "zouti_api_key" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'settings_zouti_webhook_token_unique'
  ) THEN
    ALTER TABLE "settings"
      ADD CONSTRAINT "settings_zouti_webhook_token_unique" UNIQUE ("zouti_webhook_token");
  END IF;
END $$;
