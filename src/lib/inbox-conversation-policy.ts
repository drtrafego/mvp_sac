import { sql, type SQL } from 'drizzle-orm'
import { recoveryLeads } from '@/lib/db/schema'

/**
 * Uma compra aprovada da Kiwify é um contato/pedido até existir uma mensagem
 * real. O lead continua no CRM e nos relatórios; esta condição só impede que
 * ele seja exposto como uma conversa vazia no Inbox e na API de conversas.
 */
export function conversationVisibilityCondition(companyId: number): SQL {
  return sql`NOT (
    ${recoveryLeads.platform} = 'kiwify'
    AND ${recoveryLeads.eventType} = 'compra_aprovada'
    AND NOT EXISTS (
      SELECT 1
      FROM whatsapp_messages kiwify_purchase_history
      WHERE kiwify_purchase_history.company_id = ${companyId}
        AND (
          kiwify_purchase_history.lead_id = ${recoveryLeads.id}
          OR kiwify_purchase_history.phone = ${recoveryLeads.phone}
          OR regexp_replace(kiwify_purchase_history.phone, '\\D', '', 'g') = regexp_replace(${recoveryLeads.phone}, '\\D', '', 'g')
          OR right(regexp_replace(kiwify_purchase_history.phone, '\\D', '', 'g'), 9) = right(regexp_replace(${recoveryLeads.phone}, '\\D', '', 'g'), 9)
        )
    )
  )`
}
