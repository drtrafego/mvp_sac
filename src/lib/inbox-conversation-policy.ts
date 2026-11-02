import { sql, type SQL } from 'drizzle-orm'
import { recoveryLeads } from '@/lib/db/schema'

/**
 * A recovery lead can represent a reservation, purchase, or CRM contact.
 * It belongs in the Inbox conversation list only after a real message exists
 * for the same tenant, contact, and delivery channel.
 */
export function conversationVisibilityCondition(companyId: number): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM whatsapp_messages inbox_history
    WHERE inbox_history.company_id = ${companyId}
      AND (
        inbox_history.lead_id = ${recoveryLeads.id}
        OR inbox_history.phone = ${recoveryLeads.phone}
        OR (
          regexp_replace(inbox_history.phone, '\\D', '', 'g') <> ''
          AND regexp_replace(${recoveryLeads.phone}, '\\D', '', 'g') <> ''
          AND regexp_replace(inbox_history.phone, '\\D', '', 'g') = regexp_replace(${recoveryLeads.phone}, '\\D', '', 'g')
        )
      )
      AND coalesce(inbox_history.channel, 'whatsapp') = coalesce(${recoveryLeads.channel}, 'whatsapp')
  )`
}
