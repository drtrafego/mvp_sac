export const INSTAGRAM_DELIVERY_CHANNEL = 'instagram' as const
export const INSTAGRAM_PHONE_PREFIX = 'ig_'

export type LeadDeliveryChannel = 'instagram' | 'email' | 'whatsapp'

export interface LeadDeliveryFields {
  channel?: string | null
  phone?: string | null
}

/**
 * Fonte única da verdade para escolher o transporte de uma conversa.
 *
 * `platform` e `trackingSource` descrevem origem/categoria de negócio e podem
 * conter Instagram em leads cujo contato real é WhatsApp. Já os webhooks de
 * Direct gravam `channel='instagram'` e telefone `ig_<IGSID>`; o prefixo
 * também preserva compatibilidade com conversas antigas sem `channel`.
 */
export function resolveLeadDeliveryChannel(fields: LeadDeliveryFields): LeadDeliveryChannel {
  const channel = fields.channel?.trim().toLowerCase() || ''
  const phone = fields.phone?.trim().toLowerCase() || ''

  if (channel === INSTAGRAM_DELIVERY_CHANNEL || phone.startsWith(INSTAGRAM_PHONE_PREFIX)) {
    return INSTAGRAM_DELIVERY_CHANNEL
  }
  if (channel === 'email') return 'email'
  return 'whatsapp'
}

export function isInstagramDelivery(fields: LeadDeliveryFields): boolean {
  return resolveLeadDeliveryChannel(fields) === INSTAGRAM_DELIVERY_CHANNEL
}
