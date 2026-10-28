import { and, eq, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'

export const RECOVERY_EVENT_TYPES = ['boleto', 'pix', 'carrinho_abandonado', 'cartao_recusado'] as const

export function isRecoveryEventType(eventType: string): boolean {
  return (RECOVERY_EVENT_TYPES as readonly string[]).includes(eventType)
}

export type RecoveryOperationalState = {
  status: string | null
  convertedFrom: string | null
}

export function applyRecordedPurchaseTransition(
  state: RecoveryOperationalState,
  purchaseRecorded: boolean,
): RecoveryOperationalState {
  if (!purchaseRecorded) return state
  return { ...state, status: 'converted', convertedFrom: 'webhook' }
}

export function shouldScheduleRecoveryLead(state: RecoveryOperationalState): boolean {
  return state.status !== 'converted'
}

/**
 * A purchase webhook can arrive before the checkout-abandoned webhook. In that
 * order there is no recovery row to update when the purchase is processed, so
 * reconcile the newly inserted recovery row against the already recorded
 * purchase. This only changes the operational status; it never creates a
 * conversation or a message.
 */
export async function reconcileRecoveryLeadWithRecordedPurchase(args: {
  companyId: number
  platform: string
  leadId: number
  phone?: string | null
  email?: string | null
}): Promise<boolean> {
  const matchConditions = []
  const phone = args.phone?.trim() ?? ''
  const phoneDigits = phone.replace(/\D/g, '')
  const email = args.email?.trim().toLowerCase() ?? ''

  if (phone) {
    matchConditions.push(
      phoneDigits.length >= 9
        ? or(
            eq(recoveryLeads.phone, phone),
            sql`right(regexp_replace(${recoveryLeads.phone}, '\\D', '', 'g'), 9) = ${phoneDigits.slice(-9)}`,
          )
        : eq(recoveryLeads.phone, phone),
    )
  }
  if (email) {
    matchConditions.push(sql`lower(${recoveryLeads.email}) = ${email}`)
  }
  if (matchConditions.length === 0) return false

  const [purchase] = await db
    .select({ id: recoveryLeads.id })
    .from(recoveryLeads)
    .where(and(
      eq(recoveryLeads.companyId, args.companyId),
      eq(recoveryLeads.platform, args.platform),
      eq(recoveryLeads.eventType, 'compra_aprovada'),
      or(...matchConditions),
    ))
    .limit(1)

  const nextState = applyRecordedPurchaseTransition(
    { status: 'pending', convertedFrom: null },
    Boolean(purchase),
  )
  if (!purchase) return false

  await db
    .update(recoveryLeads)
    .set({ ...nextState, updatedAt: new Date() })
    .where(and(
      eq(recoveryLeads.id, args.leadId),
      eq(recoveryLeads.companyId, args.companyId),
    ))

  return true
}
