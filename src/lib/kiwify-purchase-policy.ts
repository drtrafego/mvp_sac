import { shouldScheduleRecoveryMessageJobs } from '@/lib/recovery-event-policy'

export const KIWIFY_PURCHASE_APPROVED_EVENT = 'compra_aprovada'

/**
 * A confirmed Kiwify purchase is a contact/order upsert only. Abandoned-cart
 * and purchase events never create follow-up jobs.
 */
export function shouldScheduleKiwifyMessageJobs(eventType: string | null | undefined): boolean {
  return shouldScheduleRecoveryMessageJobs(eventType)
}
