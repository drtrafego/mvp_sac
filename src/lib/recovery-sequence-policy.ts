/** Regras compartilhadas pelos webhooks de checkout. */

export function canScheduleAutomaticRecoverySequence(eventType: string): boolean {
  // Carrinho abandonado é apenas registro/estado. O SAC não inicia conversa
  // nem agenda mensagem automática nesse evento.
  return eventType !== 'carrinho_abandonado'
}

export const ISABELA_BOLETO_TEMPLATE_NAME = 'boleto_despertar_nao_pago'
export const ISABELA_BOLETO_JOB_TYPE = 'boleto_followup_immediate'

export const ISABELA_APPROVED_TEMPLATE_NAMES = [
  'boas_vindas_despertar_pos_compra',
  'isabela_formulario_d1_20261031_corrigida',
  'acompanhamento_desafio_d10',
  'convite_portal_apos_desafio',
  'pix_despertar_nao_pago',
  'boleto_despertar_nao_pago',
  'cartao_despertar_recusado',
] as const

export type IsabelaFlow = 'compra_aprovada' | 'portal_apos_desafio' | 'pix' | 'boleto' | 'cartao_recusado'

/**
 * Catálogo fechado dos fluxos da Bela. O webhook nunca aceita um template
 * apenas porque a Meta o marcou como APPROVED: o nome precisa estar neste
 * catálogo e na sequência explícita do fluxo correspondente.
 */
export const ISABELA_FLOW_TEMPLATE_NAMES: Readonly<Record<IsabelaFlow, readonly string[]>> = {
  compra_aprovada: [
    'boas_vindas_despertar_pos_compra',
    'isabela_formulario_d1_20261031_corrigida',
    'acompanhamento_desafio_d10',
  ],
  portal_apos_desafio: ['convite_portal_apos_desafio'],
  pix: ['pix_despertar_nao_pago'],
  boleto: ['boleto_despertar_nao_pago'],
  cartao_recusado: ['cartao_despertar_recusado'],
}

export const ISABELA_FLOW_ALLOWED_CATEGORIES: Readonly<Record<IsabelaFlow, readonly string[]>> = {
  compra_aprovada: ['UTILITY', 'MARKETING'],
  portal_apos_desafio: ['MARKETING'],
  pix: ['UTILITY'],
  boleto: ['UTILITY'],
  cartao_recusado: ['UTILITY'],
}
export const ISABELA_FLOW_JOB_TYPES = new Set([
  'isabela_purchase_sequence',
  'isabela_portal_after_challenge',
  'pix_followup_60m',
  ISABELA_BOLETO_JOB_TYPE,
  'isabela_cartao_recusado',
])

export type ApprovedIsabelaTemplate = {
  name: string
  language?: string | null
  category?: string | null
}

/** A sequência só passa quando contém exatamente os templates do seu fluxo. */
export function isConfiguredIsabelaFlow(
  messages: SequenceMessageForPolicy[],
  flow: IsabelaFlow,
  approvedTemplates: ReadonlyMap<string, ApprovedIsabelaTemplate>,
): boolean {
  const expected = ISABELA_FLOW_TEMPLATE_NAMES[flow]
  if (messages.length !== expected.length) return false

  const ordered = [...messages].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  return ordered.every((message, index) => {
    const name = message.templateName
    if (
      message.messageType !== 'template'
      || !name
      || name !== expected[index]
      || (message.templateLanguage ?? 'pt_BR') !== 'pt_BR'
    ) return false

    const approved = approvedTemplates.get(name)
    if (!approved) return false
    return (approved.language ?? 'pt_BR') === 'pt_BR'
      && ISABELA_FLOW_ALLOWED_CATEGORIES[flow].includes((approved.category ?? '').toUpperCase())
  })
}

export function buildIsabelaFlowIdempotencyKey(
  flow: IsabelaFlow,
  companyId: number,
  transactionId: string,
  messageId: number,
): string {
  return `isabela:${flow}:${companyId}:${transactionId.trim()}:${messageId}`
}

export function isIsabelaJobType(jobType: string | null | undefined): boolean {
  return Boolean(jobType && ISABELA_FLOW_JOB_TYPES.has(jobType))
}

export function isWhatsAppOptOutText(text: string | null | undefined): boolean {
  if (!text) return false
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return [
    'pare',
    'parar',
    'stop',
    'optout',
    'opt out',
    'sair',
    'descadastrar',
    'cancelar mensagens',
    'nao quero receber',
    'nao me mande mais',
    'nao enviar mais',
  ].some(pattern => normalized === pattern || normalized.startsWith(`${pattern} `))
}

export function buildIsabelaBoletoIdempotencyKey(companyId: number, transactionId: string): string {
  return `${ISABELA_BOLETO_JOB_TYPE}:${companyId}:${transactionId.trim()}`
}

export type SequenceMessageForPolicy = {
  messageType?: string | null
  templateName?: string | null
  order?: number | null
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
 * Isabela só usa nomes de template aprovados e previamente autorizados para
 * os fluxos deste tenant. Os coringas ficam deliberadamente fora da lista,
 * mesmo quando a Meta os classifica como APPROVED.
 */
export function isApprovedIsabelaSequence(
  messages: SequenceMessageForPolicy[],
  approvedTemplateNames: ReadonlySet<string>,
): boolean {
  const allowedNames = new Set<string>(ISABELA_APPROVED_TEMPLATE_NAMES)
  return messages.length > 0 && messages.every(message =>
    message.messageType === 'template'
    && Boolean(message.templateName)
    && (message.templateLanguage ?? 'pt_BR') === 'pt_BR'
    && allowedNames.has(message.templateName as string)
    && approvedTemplateNames.has(message.templateName as string)
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

  const variableMap = message.templateVariablesMap && typeof message.templateVariablesMap === 'object'
    ? message.templateVariablesMap as Record<string, unknown>
    : {}
  const variableKeys = Object.keys(variableMap)
  const expectedNamedKeys = ['customer_name', 'order_reference', 'payment_due_date']
  if (variableKeys.sort().join('|') === expectedNamedKeys.sort().join('|')) {
    return variableMap.customer_name === '{nome}'
      && variableMap.order_reference === '{transacao}'
      && variableMap.payment_due_date === '{boleto_validade}'
  }

  const variableValues = Object.values(variableMap).filter((value): value is string => typeof value === 'string')

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
