/** Regras compartilhadas pelos webhooks de checkout. */

export function canScheduleAutomaticRecoverySequence(eventType: string): boolean {
  // Carrinho abandonado é apenas registro/estado. O SAC não inicia conversa
  // nem agenda mensagem automática nesse evento.
  return eventType !== 'carrinho_abandonado'
}

export const ISABELA_BOLETO_TEMPLATE_NAME = 'boleto_despertar_nao_pago'
export const ISABELA_BOLETO_JOB_TYPE = 'boleto_followup_immediate'

export function buildIsabelaBoletoIdempotencyKey(companyId: number, transactionId: string): string {
  return `${ISABELA_BOLETO_JOB_TYPE}:${companyId}:${transactionId.trim()}`
}

export type SequenceMessageForPolicy = {
  messageType?: string | null
  templateName?: string | null
  templateLanguage?: string | null
  delayMinutes?: number | null
  templateVariablesMap?: unknown
}

/** A sequência da Isabela só aceita modelos UTILITY aprovados e sincronizados. */
export function isApprovedUtilitySequence(
  messages: SequenceMessageForPolicy[],
  approvedUtilityTemplateNames: ReadonlySet<string>,
): boolean {
  return messages.length > 0 && messages.every(message =>
    message.messageType === 'template'
    && Boolean(message.templateName)
    && approvedUtilityTemplateNames.has(message.templateName as string)
  )
}

/**
 * O boleto do Despertar é uma única mensagem transacional, imediata e com os
 * dois dados que tornam o boleto utilizável. A política é intencionalmente
 * específica para não transformar outras sequências em boleto.
 */
export function isApprovedImmediateIsabelaBoletoSequence(
  messages: SequenceMessageForPolicy[],
  approvedUtilityTemplateNames: ReadonlySet<string>,
): boolean {
  if (messages.length !== 1) return false

  const [message] = messages
  if (
    message.messageType !== 'template'
    || message.templateName !== ISABELA_BOLETO_TEMPLATE_NAME
    || !approvedUtilityTemplateNames.has(ISABELA_BOLETO_TEMPLATE_NAME)
    || (message.templateLanguage ?? 'pt_BR') !== 'pt_BR'
    || (message.delayMinutes ?? 0) !== 0
  ) return false

  const variableValues = Object.values(
    message.templateVariablesMap && typeof message.templateVariablesMap === 'object'
      ? message.templateVariablesMap as Record<string, unknown>
      : {},
  ).filter((value): value is string => typeof value === 'string')

  return variableValues.some(value => value.includes('{boleto_codigo}'))
    && variableValues.some(value => value.includes('{boleto_validade}'))
}

/**
 * Checkout só autoriza o disparo quando traz um opt-in explícito para
 * WhatsApp. Ausência do campo é bloqueio; não inferimos consentimento a partir
 * da existência de telefone, compra ou aceite genérico de termos.
 */
export function hasExplicitWhatsAppConsent(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false

  const root = payload as Record<string, unknown>
  const asRecord = (value: unknown): Record<string, unknown> | null => (
    value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  )
  const nested = [
    asRecord(root.Customer),
    asRecord(root.customer),
    asRecord(root.client),
    asRecord(root.lead),
    asRecord(root.buyer),
    asRecord(root.data),
    asRecord(asRecord(root.data)?.buyer),
    asRecord(asRecord(root.data)?.customer),
  ].filter((value): value is Record<string, unknown> => Boolean(value))

  const values = [
    root.whatsapp_opt_in,
    root.whatsapp_consent,
    root.consentimento_whatsapp,
    ...nested.flatMap(value => [
      value.whatsapp_opt_in,
      value.whatsapp_consent,
      value.consentimento_whatsapp,
    ]),
  ]

  return values.some(value => value === true || (typeof value === 'string' && ['true', 'yes', 'sim', '1'].includes(value.trim().toLowerCase())))
}
