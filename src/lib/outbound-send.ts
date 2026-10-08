import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import { recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { sendWhatsAppMessage } from '@/lib/whatsapp'
import { sendInstagramMessage } from '@/lib/instagram'
import { sendBrevoEmail } from '@/lib/email/brevo'
import { markLeadContacted } from '@/lib/leads'
import { resolveLeadDeliveryChannel } from '@/lib/lead-delivery-channel'
import { eq, and } from 'drizzle-orm'

type MessageRow = typeof whatsappMessages.$inferSelect
export interface OutboundSendInput {
  companyId: number
  lead: typeof recoveryLeads.$inferSelect
  content?: string | null
  mediaUrl?: string | null
  messageType?: string | null
  clientRequestId?: string | null
  sentBy?: 'human' | 'bot' | 'system'
  senderName?: string | null
  agentId?: string | null
  subject?: string | null
  beforeTransport?: () => Promise<boolean>
}

export interface OutboundSendResult {
  ok: boolean
  status: 200 | 202 | 400 | 409 | 502
  message: MessageRow | null
  error?: string
  isTimeout?: boolean
  idempotentReplay?: boolean
}

// Dependencies expose the real orchestration for regression tests without a live provider.
export interface OutboundSendStore {
  find(companyId: number, requestId: string): Promise<MessageRow | undefined>
  create(values: typeof whatsappMessages.$inferInsert): Promise<MessageRow | undefined>
  claimFailed(companyId: number, id: number): Promise<MessageRow | undefined>
  finish(companyId: number, id: number, values: Partial<typeof whatsappMessages.$inferInsert>): Promise<MessageRow>
  touchLead(leadId: number): Promise<void>
}
interface TransportResult {
  ok: boolean
  externalId?: string | null
  error?: unknown
  uncertain?: boolean
  isTimeout?: boolean
}
export interface OutboundSendDependencies {
  store: OutboundSendStore
  transport(input: OutboundSendInput, channel: 'whatsapp' | 'instagram' | 'email'): Promise<TransportResult>
}

/** Safe, bounded error text; never persist an arbitrary provider object or credential. */
export function safeOutboundError(error: unknown): string {
  let text = 'Falha no transporte de envio.'
  if (typeof error === 'string') text = error
  else if (error instanceof Error) text = error.message
  else if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') text = error.message
  return text
    .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redigido]')
    .replace(/((?:access_token|api[_-]?key|token|authorization)\s*[=:]\s*)[^&\s"',;]+/gi, '$1[redigido]')
    .replace(/("(?:access_token|api[_-]?key|token|authorization)"\s*:\s*")[^"]*/gi, '$1[redigido]')
    .slice(0, 500)
}

export function isOutboundTimeout(error: unknown): boolean {
  const value = error as { name?: string; code?: string; cause?: { code?: string } } | null
  return value?.name === 'AbortError' || value?.name === 'TimeoutError'
    || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(value?.code || value?.cause?.code || '')
    || /timeout|aborterror/i.test(error instanceof Error ? error.message : String(error))
}

function payloadHash(input: OutboundSendInput, channel: string): string {
  return createHash('sha256').update(JSON.stringify({
    companyId: input.companyId, leadId: input.lead.id, channel,
    recipient: channel === 'email' ? input.lead.email : input.lead.phone,
    content: input.content || '', mediaUrl: input.mediaUrl || null,
    messageType: input.messageType || 'text', sentBy: input.sentBy || 'human',
    subject: channel === 'email' ? input.subject || `Re: Atendimento - ${input.lead.productName || 'SAC'}` : null,
  })).digest('hex')
}

function matchesRequest(row: MessageRow, input: OutboundSendInput, channel: string, hash: string): boolean {
  if (row.leadId !== input.lead.id || row.channel !== channel || row.direction !== 'outbound') return false
  if (row.outboundPayloadHash) return row.outboundPayloadHash === hash
  // Legacy email rows have no immutable recipient/subject snapshot: fail closed.
  if (channel === 'email') return false
  return row.phone === input.lead.phone && (row.content || '') === (input.content || '')
    && (row.mediaUrl || null) === (input.mediaUrl || null)
    && (row.messageType || 'text') === (input.messageType || 'text')
    && (row.sentBy || 'human') === (input.sentBy || 'human')
}

function replay(row: MessageRow): OutboundSendResult {
  if (row.sendState === 'accepted') return { ok: true, status: 200, message: row, idempotentReplay: true }
  return {
    ok: false, status: 202, message: row, idempotentReplay: true,
    isTimeout: row.sendState === 'uncertain',
    error: row.sendState === 'uncertain'
      ? 'Envio incerto. Confirme o resultado antes de tentar novamente.'
      : 'Envio em processamento. Aguarde a confirmação; nada foi reenviado.',
  }
}

/** Reuse a failed intent with an atomic claim; never replay pending/uncertain transports. */
export function createOutboundSender({ store, transport }: OutboundSendDependencies) {
  return async function send(input: OutboundSendInput): Promise<OutboundSendResult> {
    const channel = resolveLeadDeliveryChannel(input.lead)
    if (input.lead.companyId !== input.companyId) return { ok: false, status: 400, message: null, error: 'Empresa do contato incompatível.' }
    if (typeof input.content !== 'string' && input.content != null) return { ok: false, status: 400, message: null, error: 'Conteúdo inválido.' }
    if (!(input.content || '').trim() && !input.mediaUrl) return { ok: false, status: 400, message: null, error: 'Informe texto ou mídia para envio.' }
    const type = input.messageType || 'text'
    if (!['text', 'image', 'video', 'audio', 'document'].includes(type)) return { ok: false, status: 400, message: null, error: 'Tipo de mensagem não suportado neste endpoint.' }
    if (input.mediaUrl && type === 'text') return { ok: false, status: 400, message: null, error: 'Informe o tipo da mídia (imagem, vídeo, áudio ou documento).' }
    if (type !== 'text' && !input.mediaUrl) return { ok: false, status: 400, message: null, error: 'Informe a mídia para este tipo de mensagem.' }
    if (channel === 'email' && input.mediaUrl) return { ok: false, status: 400, message: null, error: 'Anexos por e-mail ainda não são suportados neste endpoint.' }
    if (channel === 'instagram' && type === 'document') return { ok: false, status: 400, message: null, error: 'Este canal não aceita documento neste endpoint.' }
    if (channel === 'email' && !input.lead.email) return { ok: false, status: 400, message: null, error: 'Contato sem endereço de e-mail.' }
    const requestId = input.clientRequestId?.trim() || null
    if (requestId && requestId.length > 200) return { ok: false, status: 400, message: null, error: 'Chave de envio muito longa.' }
    const hash = payloadHash(input, channel)
    let row = requestId ? await store.find(input.companyId, requestId) : undefined
    if (!row) {
      row = await store.create({
        companyId: input.companyId, leadId: input.lead.id, phone: input.lead.phone,
        channel, direction: 'outbound', content: input.content || null,
        messageType: input.messageType || 'text', mediaUrl: input.mediaUrl || null,
        sentBy: input.sentBy || 'human', senderName: input.senderName || null,
        agentId: input.agentId || null, clientRequestId: requestId,
        outboundPayloadHash: hash, sendState: 'pending',
      })
      // A concurrent request won the unique key; read and replay its state.
      if (!row) row = requestId ? await store.find(input.companyId, requestId) : undefined
      else return dispatch(row)
    }
    if (!row) throw new Error('Não foi possível recuperar a intenção de envio.')
    if (!matchesRequest(row, input, channel, hash)) return {
      ok: false, status: 409, message: null,
      error: 'Esta chave pertence a outra mensagem. Não reutilize a chave para conteúdo ou contato diferentes.',
    }
    if (row.sendState !== 'failed') return replay(row)
    const claimed = await store.claimFailed(input.companyId, row.id)
    if (!claimed) {
      const current = requestId ? await store.find(input.companyId, requestId) : row
      return replay(current || row)
    }
    return dispatch(claimed)

    async function dispatch(intent: MessageRow): Promise<OutboundSendResult> {
      if (input.beforeTransport) {
        let allowed = false
        let guardError: unknown = null
        try { allowed = await input.beforeTransport() } catch (error) { guardError = error }
        if (!allowed) {
          const error = guardError ? safeOutboundError(guardError) : 'Envio cancelado pelo controle do atendimento.'
          const message = await store.finish(input.companyId, intent.id, { sendState: 'failed', sendError: error })
          return { ok: false, status: guardError ? 502 : 409, message, error }
        }
      }
      let result: TransportResult
      try { result = await transport(input, channel) }
      catch (error) {
        // A network exception gives no definitive provider rejection. Do not resend blindly.
        result = { ok: false, error, uncertain: true, isTimeout: isOutboundTimeout(error) }
      }
      const state = result.ok ? 'accepted' : result.uncertain ? 'uncertain' : 'failed'
      const error = result.ok ? undefined : safeOutboundError(result.error)
      let message: MessageRow
      try {
        message = await store.finish(input.companyId, intent.id, {
          sendState: state, sendError: error || null, externalId: result.externalId || null,
        })
      } catch {
        // Provider may already have accepted; leave intent non-retryable and report uncertainty.
        return { ok: false, status: 202, message: { ...intent, sendState: 'uncertain' }, error: 'Resultado do envio ainda não registrado. Confirme antes de repetir.' }
      }
      if (!result.ok) return { ok: false, status: result.uncertain ? 202 : 502, message, error, isTimeout: result.isTimeout }
      // Follow-up bookkeeping cannot turn an accepted transport into a false send failure.
      await store.touchLead(input.lead.id).catch(() => console.warn('[SAC send] envio aceito; atualização do contato pendente', { leadId: input.lead.id }))
      return { ok: true, status: 200, message }
    }
  }
}

const store: OutboundSendStore = {
  async find(companyId, requestId) {
    const [row] = await db.select().from(whatsappMessages)
      .where(and(eq(whatsappMessages.companyId, companyId), eq(whatsappMessages.clientRequestId, requestId))).limit(1)
    return row
  },
  async create(values) {
    const [row] = await db.insert(whatsappMessages).values(values).onConflictDoNothing().returning()
    return row
  },
  async claimFailed(companyId, id) {
    const [row] = await db.update(whatsappMessages).set({ sendState: 'pending', sendError: null })
      .where(and(eq(whatsappMessages.companyId, companyId), eq(whatsappMessages.id, id), eq(whatsappMessages.sendState, 'failed'))).returning()
    return row
  },
  async finish(companyId, id, values) {
    const [row] = await db.update(whatsappMessages).set(values)
      .where(and(eq(whatsappMessages.companyId, companyId), eq(whatsappMessages.id, id))).returning()
    if (!row) throw new Error('Intenção de envio não encontrada.')
    return row
  },
  async touchLead(id) {
    await markLeadContacted(id)
    await db.update(recoveryLeads).set({ updatedAt: new Date(), lastActionAt: new Date() }).where(eq(recoveryLeads.id, id))
  },
}

async function transport(input: OutboundSendInput, channel: 'whatsapp' | 'instagram' | 'email'): Promise<TransportResult> {
  if (channel === 'instagram') {
    const result = await sendInstagramMessage({
      recipientId: input.lead.phone, text: input.content || '', mediaUrl: input.mediaUrl || undefined,
      mediaType: input.messageType === 'audio' || input.messageType === 'video' ? input.messageType : 'image',
      companyId: input.companyId,
    })
    return { ...result, externalId: result.messageId || null }
  }
  if (channel === 'email') {
    const content = input.content || ''
    const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const result = await sendBrevoEmail({
      to: [{ email: input.lead.email!, name: input.lead.name || undefined }],
      subject: input.subject || `Re: Atendimento - ${input.lead.productName || 'SAC'}`,
      htmlContent: `<p>${escaped.replace(/\n/g, '<br/>')}</p>`, textContent: content, companyId: input.companyId,
    })
    return { ...result, externalId: result.data?.messageId || null }
  }
  try {
    const externalId = await sendWhatsAppMessage(input.lead.phone, {
      type: input.messageType || 'text', content: input.content || '', mediaUrl: input.mediaUrl || undefined, caption: input.content || undefined,
    }, input.companyId)
    return { ok: true, externalId }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const definitive = /^(?:Meta API (?:erro|rate limit) \d+|UazAPI \w+ erro \d+|WhatsApp não configurado|Meta Cloud API não configurada|UazAPI não configurada|Provedor desconhecido)/.test(message)
    return { ok: false, error, uncertain: !definitive, isTimeout: isOutboundTimeout(error) }
  }
}

export const sendOutboundForLead = createOutboundSender({ store, transport })
