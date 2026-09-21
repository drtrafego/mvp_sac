-- Migração aditiva (expand): adiciona somente duas colunas nullable em
-- settings, sem alterar nem remover dados existentes. Elas guardam a
-- credencial e a conta da Meta Marketing API usadas para atribuir leads a
-- campanhas, conjuntos e anúncios.
--
-- Este projeto usa self-healing schema via ensureSchema() em
-- src/lib/db/index.ts. A migration SQL é apenas documental e mantém a
-- sequência das alterações de schema explícita no repositório.

ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "meta_ads_access_token" text;
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "meta_ads_account_id" text;
