import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'

/**
 * Já existe compra aprovada para este pedido? A Kiwify pode entregar pix_created,
 * billet_created ou order_rejected DEPOIS do order_approved do mesmo order_id
 * (entrega fora de ordem); cobrar quem já pagou não pode acontecer.
 */
export async function hasApprovedPurchaseForOrder(companyId: number, transactionId: string | null | undefined): Promise<boolean> {
  const id = transactionId?.trim()
  if (!id) return false
  const [row] = await db
    .select({ id: recoveryLeads.id })
    .from(recoveryLeads)
    .where(and(
      eq(recoveryLeads.companyId, companyId),
      eq(recoveryLeads.eventType, 'compra_aprovada'),
      eq(recoveryLeads.transactionId, id),
    ))
    .limit(1)
  return Boolean(row)
}
