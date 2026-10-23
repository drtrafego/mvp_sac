-- Métrica de entrada humana real, em UTC. É aditiva e segura para executar
-- mais de uma vez. Não reutiliza first_contact_at porque esse campo também
-- recebe a primeira mensagem outbound de uma campanha ou do bot.

ALTER TABLE recovery_leads
  ADD COLUMN IF NOT EXISTS first_human_message_at timestamptz;
ALTER TABLE recovery_leads
  ADD COLUMN IF NOT EXISTS first_human_message_channel text;
ALTER TABLE recovery_leads
  ADD COLUMN IF NOT EXISTS first_human_message_agent_key text;

CREATE INDEX IF NOT EXISTS recovery_leads_first_human_message_daily_idx
  ON recovery_leads (
    company_id,
    first_human_message_at,
    first_human_message_channel,
    first_human_message_agent_key
  );

-- Backfill histórico, apenas para linhas ainda sem a marca. DISTINCT ON
-- preserva a mensagem inbound mais antiga, inclusive quando o sync trouxe
-- mensagens fora de ordem. Empate por created_at é decidido pelo menor id.
UPDATE recovery_leads AS lead
SET
  first_human_message_at = inbound.created_at AT TIME ZONE 'UTC',
  first_human_message_channel = inbound.channel,
  first_human_message_agent_key = COALESCE(
    (SELECT ai_agent_key FROM settings WHERE company_id = lead.company_id LIMIT 1),
    (SELECT slug FROM companies WHERE id = lead.company_id LIMIT 1),
    'unassigned'
  )
FROM (
  SELECT DISTINCT ON (lead_id, company_id)
    lead_id,
    company_id,
    created_at,
    channel
  FROM whatsapp_messages
  WHERE lead_id IS NOT NULL
    AND direction = 'inbound'
  ORDER BY lead_id, company_id, created_at ASC, id ASC
) AS inbound
WHERE lead.id = inbound.lead_id
  AND lead.company_id = inbound.company_id
  AND lead.first_human_message_at IS NULL;

-- Cobre toda escrita futura na camada compartilhada, inclusive integrações
-- novas que ainda não chamem o helper TypeScript. direction='inbound' é a
-- semântica do contato falando; automações e campanhas são outbound.
CREATE OR REPLACE FUNCTION capture_first_human_message_metric()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.lead_id IS NOT NULL AND NEW.direction = 'inbound' THEN
    UPDATE recovery_leads
    SET
      first_human_message_at = NEW.created_at AT TIME ZONE 'UTC',
      first_human_message_channel = NEW.channel,
      first_human_message_agent_key = COALESCE(
        (SELECT ai_agent_key FROM settings WHERE company_id = recovery_leads.company_id LIMIT 1),
        (SELECT slug FROM companies WHERE id = recovery_leads.company_id LIMIT 1),
        'unassigned'
      )
    WHERE id = NEW.lead_id
      AND company_id = NEW.company_id
      AND first_human_message_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS whatsapp_messages_first_human_message_metric ON whatsapp_messages;
CREATE TRIGGER whatsapp_messages_first_human_message_metric
AFTER INSERT ON whatsapp_messages
FOR EACH ROW EXECUTE FUNCTION capture_first_human_message_metric();

-- Artefato operacional. Uma linha por empresa, dia UTC, bot e canal. A soma
-- de contacts_with_first_human_message é a contagem diária real de pessoas
-- que iniciaram conversa, sem contar outbound, automação ou novas mensagens
-- do mesmo contato.
CREATE OR REPLACE VIEW first_human_messages_daily AS
SELECT
  company_id,
  (first_human_message_at AT TIME ZONE 'UTC')::date AS first_human_message_day_utc,
  COALESCE(first_human_message_agent_key, 'unassigned') AS agent_key,
  COALESCE(first_human_message_channel, 'unknown') AS channel,
  COUNT(*)::integer AS contacts_with_first_human_message
FROM recovery_leads
WHERE first_human_message_at IS NOT NULL
GROUP BY 1, 2, 3, 4;
