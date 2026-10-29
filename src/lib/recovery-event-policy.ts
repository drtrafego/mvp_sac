export const ABANDONED_CART_EVENT = 'carrinho_abandonado'
export const PURCHASE_APPROVED_EVENT = 'compra_aprovada'

/** Checkout events that must never create a new outbound message job. */
export function shouldScheduleRecoveryMessageJobs(eventType: string | null | undefined): boolean {
  return eventType !== ABANDONED_CART_EVENT && eventType !== PURCHASE_APPROVED_EVENT
}

/** An abandoned-cart webhook updates CRM state only; it must not notify a phone. */
export function shouldSendRecoveryNotification(eventType: string | null | undefined): boolean {
  return eventType !== ABANDONED_CART_EVENT
}
