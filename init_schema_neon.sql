-- ============================================================================
-- SAC CORE DATABASE SCHEMA (NEON POSTGRESQL)
-- ============================================================================

-- 1. Tabela de Empresas (multi-tenant)
CREATE TABLE IF NOT EXISTS "companies" (
  "id" serial PRIMARY KEY,
  "stack_auth_user_id" text UNIQUE,
  "name" text NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "plan" text DEFAULT 'free',
  "invite_token" text UNIQUE,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

-- 2. Tabela de Configurações das Empresas
CREATE TABLE IF NOT EXISTS "settings" (
  "id" serial PRIMARY KEY,
  "company_id" integer NOT NULL UNIQUE REFERENCES "companies"("id") ON DELETE CASCADE,
  "hotmart_webhook_token" text UNIQUE,
  "hotmart_client_id" text,
  "hotmart_client_secret" text,
  "greenn_webhook_token" text UNIQUE,
  "greenn_public_key" text,
  "greenn_api_key" text,
  "zouti_webhook_token" text UNIQUE,
  "zouti_api_key" text,
  "kiwify_webhook_token" text UNIQUE,
  "whatsapp_provider" text DEFAULT 'meta',
  "meta_phone_number_id" text,
  "meta_access_token" text,
  "meta_verify_token" text,
  "meta_waba_id" text,
  "uazapi_base_url" text,
  "uazapi_instance_token" text,
  "notification_phone" text,
  "updated_at" timestamp DEFAULT now()
);

-- 3. Sequências de Recuperação
CREATE TABLE IF NOT EXISTS "recovery_sequences" (
  "id" serial PRIMARY KEY,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "is_active" boolean DEFAULT false,
  "name" text NOT NULL,
  "product_filter" text,
  "upsell_message" text,
  "upsell_delay_minutes" integer DEFAULT 1440,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "recovery_sequences_company_event_unique" 
ON "recovery_sequences" ("company_id", "event_type");

-- 4. Mensagens da Sequência
CREATE TABLE IF NOT EXISTS "sequence_messages" (
  "id" serial PRIMARY KEY,
  "sequence_id" integer REFERENCES "recovery_sequences"("id") ON DELETE CASCADE,
  "order" integer NOT NULL,
  "delay_minutes" integer DEFAULT 0,
  "message_type" text DEFAULT 'text',
  "content" text,
  "media_url" text,
  "caption" text,
  "buttons_json" jsonb,
  "template_name" text,
  "template_language" text DEFAULT 'pt_BR',
  "template_variables_map" jsonb,
  "is_active" boolean DEFAULT true,
  "created_at" timestamp DEFAULT now()
);

-- 5. Leads de Recuperação (Vendas / Abandonos)
CREATE TABLE IF NOT EXISTS "recovery_leads" (
  "id" serial PRIMARY KEY,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "platform" text,
  "event_type" text NOT NULL,
  "phone" text NOT NULL,
  "name" text,
  "email" text,
  "cpf_cnpj" text,
  "city" text,
  "state" text,
  "country" text,
  "zipcode" text,
  "product_id" text,
  "product_name" text,
  "product_value" integer,
  "transaction_id" text,
  "payment_type" text,
  "installments" integer,
  "boleto_code" text,
  "boleto_url" text,
  "boleto_expiry" timestamp,
  "pix_code" text,
  "pix_expiry" timestamp,
  "checkout_url" text,
  "tracking_source" text,
  "tracking_source_sck" text,
  "tracking_external_code" text,
  "utm_medium" text,
  "utm_campaign" text,
  "utm_content" text,
  "utm_term" text,
  "utm_placement" text,
  "meta_campaign_id" text,
  "meta_adset_id" text,
  "meta_ad_id" text,
  "affiliate_code" text,
  "commission_value" integer,
  "order_date" timestamp,
  "approved_date" timestamp,
  "is_order_bump" boolean DEFAULT false,
  "raw_payload" jsonb,
  "status" text DEFAULT 'pending',
  "priority" integer DEFAULT 0,
  "converted_by_job_id" integer,
  "converted_from" text,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "recovery_leads_txn_dedup_unique"
ON "recovery_leads" ("company_id", "platform", "transaction_id", "event_type")
WHERE "transaction_id" IS NOT NULL;

-- 6. Fila de Envios Agendados
CREATE TABLE IF NOT EXISTS "message_jobs" (
  "id" serial PRIMARY KEY,
  "lead_id" integer REFERENCES "recovery_leads"("id") ON DELETE CASCADE,
  "message_id" integer REFERENCES "sequence_messages"("id") ON DELETE SET NULL,
  "upsell_content" text,
  "scheduled_for" timestamp NOT NULL,
  "sent_at" timestamp,
  "status" text DEFAULT 'pending',
  "error" text,
  "check_before_send" boolean DEFAULT false,
  "external_wamid" text,
  "delivery_status" text,
  "message_order" integer,
  "created_at" timestamp DEFAULT now()
);

-- 7. Histórico de Mensagens WhatsApp
CREATE TABLE IF NOT EXISTS "whatsapp_messages" (
  "id" serial PRIMARY KEY,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "lead_id" integer REFERENCES "recovery_leads"("id") ON DELETE SET NULL,
  "phone" text NOT NULL,
  "direction" text NOT NULL,
  "content" text,
  "message_type" text DEFAULT 'text',
  "media_url" text,
  "sent_by" text DEFAULT 'system',
  "external_id" text,
  "created_at" timestamp DEFAULT now()
);

-- 8. Log de Webhooks Recebidos
CREATE TABLE IF NOT EXISTS "webhook_received" (
  "id" serial PRIMARY KEY,
  "company_id" integer REFERENCES "companies"("id") ON DELETE CASCADE,
  "slug" text,
  "source" text DEFAULT 'hotmart',
  "event" text,
  "processed" boolean DEFAULT false,
  "skip_reason" text,
  "error_message" text,
  "lead_id" integer,
  "raw_body" jsonb,
  "headers" jsonb,
  "received_at" timestamp DEFAULT now()
);

-- 9. Membros da Equipe / Titulares
CREATE TABLE IF NOT EXISTS "company_members" (
  "id" serial PRIMARY KEY,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "stack_auth_user_id" text,
  "email" text NOT NULL,
  "name" text,
  "role" text DEFAULT 'admin' NOT NULL,
  "invite_token" text UNIQUE,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
