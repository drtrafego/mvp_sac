import { sql, type SQL } from 'drizzle-orm'
import { recoveryLeads } from '@/lib/db/schema'

/**
 * A recovery lead can represent a reservation, purchase, or CRM contact.
 * It belongs in the Inbox conversation list only after a real message exists
 * for the same tenant, contact, and delivery channel.
 */
export function conversationVisibilityCondition(companyId: number): SQL {
  const channel = sql`coalesce(${recoveryLeads.channel}, 'whatsapp')`
  const normalizedLeadPhone = sql`regexp_replace(${recoveryLeads.phone}, '\\D', '', 'g')`
  return sql`(
    (
      ${recoveryLeads.id}, ${channel}
    ) IN (
      SELECT inbox_by_lead.lead_id, coalesce(inbox_by_lead.channel, 'whatsapp')
      FROM whatsapp_messages inbox_by_lead
      WHERE inbox_by_lead.company_id = ${companyId}
        AND inbox_by_lead.lead_id IS NOT NULL
    )
    OR (
      ${recoveryLeads.phone}, ${channel}
    ) IN (
      SELECT inbox_by_phone.phone, coalesce(inbox_by_phone.channel, 'whatsapp')
      FROM whatsapp_messages inbox_by_phone
      WHERE inbox_by_phone.company_id = ${companyId}
        AND inbox_by_phone.phone IS NOT NULL
    )
    OR (
      ${normalizedLeadPhone} <> ''
      AND (
        ${normalizedLeadPhone}, ${channel}
      ) IN (
        SELECT regexp_replace(inbox_by_normalized_phone.phone, '\\D', '', 'g'),
               coalesce(inbox_by_normalized_phone.channel, 'whatsapp')
        FROM whatsapp_messages inbox_by_normalized_phone
        WHERE inbox_by_normalized_phone.company_id = ${companyId}
          AND inbox_by_normalized_phone.phone IS NOT NULL
      )
    )
  )`
}
