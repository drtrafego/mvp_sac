import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { eq, and, isNull, inArray, sql } from 'drizzle-orm'

/**
 * Marca a primeira abordagem real de um lead (mensagem de verdade, inbound ou
 * outbound). Idempotente: só grava se ainda estiver nulo, então pode ser
 * chamada em toda troca de mensagem sem custo de sobrescrever a data real.
 *
 * Decisão de negócio: lead sem first_contact_at nunca foi contatado de fato e
 * não deve contar no número principal do dashboard (Leads Captados / Total de
 * Contatos), mesmo que já exista uma linha para ele em recovery_leads.
 */
export async function markLeadContacted(leadId: number | null | undefined, when: Date = new Date()): Promise<void> {
  if (!leadId) return
  await db
    .update(recoveryLeads)
    .set({ firstContactAt: when })
    .where(and(eq(recoveryLeads.id, leadId), isNull(recoveryLeads.firstContactAt)))
}

/**
 * Backfill em lote: para os leadIds informados (ou todos, se omitido), preenche
 * first_contact_at com a data da mensagem mais antiga já registrada em
 * whatsapp_messages, só onde ainda está nulo. Usado depois de importar
 * histórico de conversas (sync-agents) e na migração inicial.
 */
export async function backfillFirstContactFromMessages(leadIds?: number[]): Promise<void> {
  if (leadIds && leadIds.length === 0) return

  if (leadIds && leadIds.length > 0) {
    await db.execute(sql`
      update recovery_leads rl
      set first_contact_at = wm.min_created
      from (
        select lead_id, min(created_at) as min_created
        from whatsapp_messages
        where lead_id = any(${leadIds})
        group by lead_id
      ) wm
      where rl.id = wm.lead_id and rl.first_contact_at is null
    `)
    return
  }

  await db.execute(sql`
    update recovery_leads rl
    set first_contact_at = wm.min_created
    from (
      select lead_id, min(created_at) as min_created
      from whatsapp_messages
      group by lead_id
    ) wm
    where rl.id = wm.lead_id and rl.first_contact_at is null
  `)
}
