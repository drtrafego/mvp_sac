ALTER TABLE "recovery_leads" ADD COLUMN IF NOT EXISTS "agent_conversation_id" text;
ALTER TABLE "recovery_leads" ADD COLUMN IF NOT EXISTS "agent_cost_usd" numeric(18, 8);
ALTER TABLE "recovery_leads" ADD COLUMN IF NOT EXISTS "agent_input_tokens" bigint;
ALTER TABLE "recovery_leads" ADD COLUMN IF NOT EXISTS "agent_output_tokens" bigint;
ALTER TABLE "recovery_leads" ADD COLUMN IF NOT EXISTS "agent_synced_at" timestamptz;

ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "reasoning" text;
ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "sent_email" text;

CREATE INDEX IF NOT EXISTS "whatsapp_messages_company_lead_created_id_idx"
  ON "whatsapp_messages" ("company_id", "lead_id", "created_at", "id");
CREATE INDEX IF NOT EXISTS "whatsapp_messages_company_phone_created_id_idx"
  ON "whatsapp_messages" ("company_id", "phone", "created_at", "id");
