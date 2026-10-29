import { sql, type SQL } from 'drizzle-orm'
import { recoveryLeads } from '@/lib/db/schema'
import { ABANDONED_CART_EVENT, PURCHASE_APPROVED_EVENT } from '@/lib/recovery-event-policy'

/**
 * Carrinho abandonado e compra aprovada são contato/estado de checkout até
 * existir uma mensagem real. O lead continua no CRM e nos relatórios; esta
 * condição só impede que uma linha sintética e vazia apareça como conversa.
 */
export function conversationVisibilityCondition(companyId: number): SQL {
  return sql`NOT (
    ${recoveryLeads.eventType} IN (${ABANDONED_CART_EVENT}, ${PURCHASE_APPROVED_EVENT})
    AND NOT EXISTS (
      SELECT 1
      FROM whatsapp_messages abandoned_cart_history
      WHERE abandoned_cart_history.company_id = ${companyId}
        AND (
          abandoned_cart_history.lead_id = ${recoveryLeads.id}
          OR (
            abandoned_cart_history.lead_id IS NULL
            AND right(regexp_replace(abandoned_cart_history.phone, '\\D', '', 'g'), 9) = right(regexp_replace(${recoveryLeads.phone}, '\\D', '', 'g'), 9)
          )
        )
    )
  )`
}
