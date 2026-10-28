export const KIWIFY_PURCHASE_APPROVED_EVENT = 'compra_aprovada'

/**
 * A confirmed Kiwify purchase is a contact/order upsert only. Follow-up jobs
 * belong to recovery events and must never be created for the purchase event.
 */
export function shouldScheduleKiwifyMessageJobs(eventType: string | null | undefined): boolean {
  return eventType !== KIWIFY_PURCHASE_APPROVED_EVENT
}
