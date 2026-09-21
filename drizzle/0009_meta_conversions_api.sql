-- Migração aditiva (expand): Pixel ID (novo campo em settings) e a tabela de
-- log de envio da Meta Conversions API. Nenhum dado existente é alterado.
--
-- Este projeto usa self-healing schema via ensureSchema() em
-- src/lib/db/index.ts. A migration SQL é apenas documental e mantém a
-- sequência das alterações de schema explícita no repositório.

ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "meta_pixel_id" text;

CREATE TABLE IF NOT EXISTS "meta_conversion_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL,
  "lead_id" integer,
  "event_name" text NOT NULL,
  "event_id" text NOT NULL,
  "pixel_id" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "http_status" integer,
  "meta_response" jsonb,
  "error_message" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_retry_at" timestamp,
  "created_at" timestamp DEFAULT now(),
  "sent_at" timestamp,
  CONSTRAINT "meta_conversion_events_company_event_unique" UNIQUE("company_id", "event_id")
);

DO $$ BEGIN
 ALTER TABLE "meta_conversion_events" ADD CONSTRAINT "meta_conversion_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "meta_conversion_events" ADD CONSTRAINT "meta_conversion_events_lead_id_recovery_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."recovery_leads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
