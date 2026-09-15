CREATE TABLE "companies" (
	"id" serial PRIMARY KEY NOT NULL,
	"stack_auth_user_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"plan" text DEFAULT 'free',
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "companies_stack_auth_user_id_unique" UNIQUE("stack_auth_user_id"),
	CONSTRAINT "companies_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "message_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" integer,
	"message_id" integer,
	"scheduled_for" timestamp NOT NULL,
	"sent_at" timestamp,
	"status" text DEFAULT 'pending',
	"error" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "recovery_leads" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"email" text,
	"product_name" text,
	"transaction_id" text,
	"raw_payload" jsonb,
	"status" text DEFAULT 'pending',
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "recovery_sequences" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"is_active" boolean DEFAULT false,
	"name" text NOT NULL,
	"upsell_message" text,
	"upsell_delay_minutes" integer DEFAULT 1440,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sequence_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"sequence_id" integer,
	"order" integer NOT NULL,
	"delay_minutes" integer DEFAULT 0,
	"message_type" text DEFAULT 'text',
	"content" text,
	"media_url" text,
	"caption" text,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"hotmart_webhook_token" text,
	"hotmart_client_id" text,
	"hotmart_client_secret" text,
	"whatsapp_provider" text DEFAULT 'green_api',
	"green_api_id_instance" text,
	"green_api_token_instance" text,
	"green_api_url" text DEFAULT 'https://api.green-api.com',
	"uazapi_base_url" text,
	"uazapi_admin_token" text,
	"uazapi_instance_token" text,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "settings_company_id_unique" UNIQUE("company_id"),
	CONSTRAINT "settings_hotmart_webhook_token_unique" UNIQUE("hotmart_webhook_token")
);
--> statement-breakpoint
CREATE TABLE "whatsapp_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"lead_id" integer,
	"phone" text NOT NULL,
	"direction" text NOT NULL,
	"content" text,
	"message_type" text DEFAULT 'text',
	"media_url" text,
	"sent_by" text DEFAULT 'system',
	"external_id" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "message_jobs" ADD CONSTRAINT "message_jobs_lead_id_recovery_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."recovery_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_jobs" ADD CONSTRAINT "message_jobs_message_id_sequence_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."sequence_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_leads" ADD CONSTRAINT "recovery_leads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_sequences" ADD CONSTRAINT "recovery_sequences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_messages" ADD CONSTRAINT "sequence_messages_sequence_id_recovery_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."recovery_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_lead_id_recovery_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."recovery_leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_sequences_company_event_unique" ON "recovery_sequences" USING btree ("company_id","event_type");