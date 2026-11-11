import { isOptOutPause } from '@/lib/message-job-class'

export const PIX_FOLLOWUP_JOB_TYPE = 'pix_followup_60m'
export const PIX_FOLLOWUP_TEMPLATE_NAME = 'pix_despertar_nao_pago'
export const PIX_FOLLOWUP_TEMPLATE_LANGUAGE = 'pt_BR'
export const PIX_FOLLOWUP_DELAY_MINUTES = 60

const ORDER_DATA_VARIABLES = new Set([
  '{nome}',
  '{primeiro_nome}',
  '{produto}',
  '{valor}',
  '{transacao}',
  '{pix_codigo}',
])

export type PixFollowupLead = {
  eventType?: string | null
  paymentType?: string | null
  phone?: string | null
  transactionId?: string | null
  pixCode?: string | null
  pixExpiry?: Date | null
  status?: string | null
  approvedDate?: Date | null
  botPaused?: boolean | null
  botPausedBy?: string | null
  whatsappConsentStatus?: string | null
}

export type PixFollowupMessage = {
  messageType?: string | null
  templateName?: string | null
  templateLanguage?: string | null
  templateVariablesMap?: unknown
  delayMinutes?: number | null
}

export type PixApprovedTemplate = {
  name: string
  language: string
  status: string
  category: string
}

export type PixFollowupGateResult =
  | { eligible: true }
  | { eligible: false; reason: string }

function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

export function isRealPendingPix(lead: PixFollowupLead): PixFollowupGateResult {
  if (lead.eventType !== 'pix' || lead.paymentType !== 'pix') {
    return { eligible: false, reason: 'evento não é Pix pendente' }
  }
  if (!nonEmpty(lead.transactionId)) {
    return { eligible: false, reason: 'pedido Pix sem transactionId real' }
  }
  if (!nonEmpty(lead.phone)) {
    return { eligible: false, reason: 'pedido Pix sem telefone real' }
  }
  if (!nonEmpty(lead.pixCode)) {
    return { eligible: false, reason: 'Pix sem código emitido' }
  }
  if (!(lead.pixExpiry instanceof Date) || Number.isNaN(lead.pixExpiry.getTime())) {
    return { eligible: false, reason: 'Pix sem validade real' }
  }
  if (lead.status === 'completed' || lead.status === 'converted' || lead.approvedDate) {
    return { eligible: false, reason: 'pagamento já confirmado' }
  }
  // Pix pendente é aviso transacional de pagamento: a pausa do bot conversacional
  // (lead, canal, geral) não o barra. Só pausa por pedido de parar do cliente.
  if (isOptOutPause(lead)) {
    return { eligible: false, reason: 'lead pausado por pedido de parar mensagens' }
  }
  if (lead.whatsappConsentStatus !== 'opted_in') {
    return { eligible: false, reason: 'consentimento WhatsApp não confirmado' }
  }
  return { eligible: true }
}

function readVariableMap(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value as Record<string, unknown>)
    .sort((a, b) => Number(a) - Number(b))
    .map(key => (value as Record<string, unknown>)[key])
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim().toLowerCase())
}

export function validatePixFollowupMessage(message: PixFollowupMessage): PixFollowupGateResult {
  if (message.messageType !== 'template') {
    return { eligible: false, reason: 'job Pix não usa mensagem template' }
  }
  if (message.templateName !== PIX_FOLLOWUP_TEMPLATE_NAME) {
    return { eligible: false, reason: `template Pix divergente de ${PIX_FOLLOWUP_TEMPLATE_NAME}` }
  }
  if ((message.templateLanguage ?? PIX_FOLLOWUP_TEMPLATE_LANGUAGE) !== PIX_FOLLOWUP_TEMPLATE_LANGUAGE) {
    return { eligible: false, reason: 'idioma do template Pix divergente de pt_BR' }
  }
  if (message.delayMinutes !== PIX_FOLLOWUP_DELAY_MINUTES) {
    return { eligible: false, reason: 'atraso do template Pix não é de 60 minutos' }
  }

  const variables = readVariableMap(message.templateVariablesMap)
  if (!variables.includes('{pix_validade}')) {
    return { eligible: false, reason: 'template Pix sem variável real de validade' }
  }
  if (!variables.some(variable => ORDER_DATA_VARIABLES.has(variable))) {
    return { eligible: false, reason: 'template Pix sem variável real do pedido' }
  }
  return { eligible: true }
}

export function isApprovedUtilityPixTemplate(template: PixApprovedTemplate | null | undefined): boolean {
  return Boolean(template
    && template.name === PIX_FOLLOWUP_TEMPLATE_NAME
    && template.language === PIX_FOLLOWUP_TEMPLATE_LANGUAGE
    && template.status.toUpperCase() === 'APPROVED'
    && template.category.toUpperCase() === 'UTILITY')
}

export function buildPixFollowupIdempotencyKey(companyId: number, transactionId: string): string {
  return `${PIX_FOLLOWUP_JOB_TYPE}:${companyId}:${transactionId.trim()}`
}
