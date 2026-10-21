/**
 * Meta Conversions API (CAPI): fecha o ciclo de otimização de anúncio,
 * avisando o Meta que um lead trazido por anúncio virou venda de verdade.
 *
 * Espelha o padrão de ads-attribution.ts: token por empresa (settings),
 * timeout curto, nunca lança exceção pro chamador, fire-and-forget do lado de
 * quem chama. Generalizado desde o início (não hardcoded pra nenhum cliente):
 * qualquer empresa que preencher settings.metaPixelId + metaAdsAccessToken
 * ganha o envio automaticamente, igual fetchAdAttribution já faz hoje.
 *
 * As vendas dos gateways não são reenviadas como conversão: Hotmart, Greenn,
 * Zouti e Kiwify já registram a compra nos próprios sistemas. O único evento
 * operacional enviado pelo SAC é `Schedule`, para reservas confirmadas pelo
 * Hermes (Gramado e futuros clientes do mesmo tipo).
 */

import { and, eq, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import { metaConversionEvents, settings } from '@/lib/db/schema'
import { isUniqueViolation } from '@/lib/webhook-dedup'
import { sendGa4Conversion } from '@/lib/ga4-conversions-sender'

const GRAPH_VERSION = (process.env.META_GRAPH_VERSION || 'v21.0').trim()
const GRAPH_HOST = 'https://graph.facebook.com'
const REQUEST_TIMEOUT_MS = 15000

export const META_EVENT_NAMES = {
  purchase: 'Purchase',
  schedule: 'Schedule',
} as const

export type MetaConversionEventName = (typeof META_EVENT_NAMES)[keyof typeof META_EVENT_NAMES]

export interface SendConversionEventParams {
  companyId: number
  leadId: number | null
  eventName: MetaConversionEventName
  /** Determinístico e reproduzível: ver purchaseEventId()/scheduleEventId() abaixo. */
  eventId: string
  phone?: string | null
  email?: string | null
  /** Dados de correspondência adicionais aceitos pela CAPI. */
  name?: string | null
  city?: string | null
  state?: string | null
  country?: string | null
  zipcode?: string | null
  /** Identificador estável do cliente, como CPF/CNPJ normalizado. */
  externalId?: string | null
  /** Payload original do provedor, usado apenas para extrair fbc/fbp/IP. */
  rawPayload?: unknown
  productId?: string | null
  productName?: string | null
  transactionId?: string | null
  /** Em REAIS, não centavos (a CAPI não usa centavos). */
  value?: number | null
  currency?: string
  eventTime?: Date
}

export type SendConversionEventResult = { ok: true } | { ok: false; error: string }

/**
 * event_id para os 4 webhooks de checkout: a transação já é única por design
 * (mesma chave que sustenta recovery_leads_txn_dedup_unique), então isto é
 * reproduzível — reenviar o mesmo transactionId nunca gera um evento novo.
 */
export function purchaseEventId(transactionId: string): string {
  return `purchase_${transactionId}`
}

/**
 * event_id para reserva/agendamento (Gramado e futuros clientes do tipo).
 * Não existe hoje um id de reserva vindo do restaurante disponível no SAC,
 * então usa o que existe: empresa + lead + timestamp da reserva.
 */
export function scheduleEventId(companyId: number, leadId: number, reservationTime: Date | number): string {
  const t = reservationTime instanceof Date ? reservationTime.getTime() : reservationTime
  return `schedule_${companyId}_${leadId}_${t}`
}

function sha256Hex(v: string): string {
  return createHash('sha256').update(v).digest('hex')
}

function normalizeText(v: string | null | undefined): string | null {
  const normalized = (v || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
  return normalized || null
}

function hashText(v: string | null | undefined): string | null {
  const normalized = normalizeText(v)
  return normalized ? sha256Hex(normalized) : null
}

function hashDigits(v: string | null | undefined): string | null {
  const digits = (v || '').replace(/\D/g, '')
  return digits ? sha256Hex(digits) : null
}

function firstPayloadValue(payload: unknown, keys: string[], depth = 0): string | null {
  if (depth > 5 || payload == null) return null
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = firstPayloadValue(item, keys, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof payload !== 'object') return null
  const object = payload as Record<string, unknown>
  for (const [key, value] of Object.entries(object)) {
    if (keys.includes(key.toLowerCase()) && typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  for (const value of Object.values(object)) {
    const found = firstPayloadValue(value, keys, depth + 1)
    if (found) return found
  }
  return null
}

function extractRawAttribution(payload: unknown): {
  fbc: string | null
  fbp: string | null
  ctwaClid: string | null
  clientIpAddress: string | null
  clientUserAgent: string | null
} {
  return {
    fbc: firstPayloadValue(payload, ['fbc']),
    fbp: firstPayloadValue(payload, ['fbp']),
    ctwaClid: firstPayloadValue(payload, ['ctwa_clid', 'ctwaclid']),
    clientIpAddress: firstPayloadValue(payload, ['client_ip_address', 'ip_address', 'ip']),
    clientUserAgent: firstPayloadValue(payload, ['client_user_agent', 'user_agent', 'useragent']),
  }
}

/** E-mail: lowercase + trim antes de hashear, exigência da própria Meta. */
export function hashEmail(email: string | null | undefined): string | null {
  const v = (email || '').trim().toLowerCase()
  if (!v) return null
  return sha256Hex(v)
}

/**
 * Telefone: E.164 sem "+" antes de hashear. recoveryLeads.phone já chega
 * normalizado assim por formatBrazilianPhone() (src/lib/whatsapp/index.ts:
 * "55" + DDD + 9 dígitos, só dígitos, sem "+"). Aqui só defende contra
 * qualquer não-dígito residual (espaço, traço, "+"), nunca reformata DDI.
 */
export function hashPhone(phone: string | null | undefined): string | null {
  const digits = (phone || '').replace(/\D/g, '')
  if (!digits) return null
  return sha256Hex(digits)
}

export interface CapiEventPayload {
  event_name: string
  event_time: number
  event_id: string
  action_source: 'system_generated'
  user_data: {
    ph?: string[]
    em?: string[]
    fn?: string[]
    ln?: string[]
    ct?: string[]
    st?: string[]
    zp?: string[]
    country?: string[]
    external_id?: string[]
    fbc?: string
    fbp?: string
    ctwa_clid?: string
    client_ip_address?: string
    client_user_agent?: string
  }
  custom_data?: {
    value?: number
    currency?: string
    order_id?: string
    content_ids?: string[]
    content_name?: string
    content_type?: string
  }
}

export interface CapiPayload {
  data: CapiEventPayload[]
}

/**
 * Monta o payload da Graph API. Função pura (sem I/O), testável sem token
 * real: ver scripts/meta-conversions-api.test.ts.
 *
 * action_source: 'system_generated' — nunca 'website' (não veio de
 * navegador) nem 'business_messaging' (esse é o valor certo só quando existe
 * ctwa_clid de Click-to-WhatsApp, que este projeto ainda não captura, ver
 * operacao/meta-conversions-api-20260921.md, seção 3.5).
 */
export function buildCapiPayload(params: {
  eventName: MetaConversionEventName
  eventId: string
  eventTime: Date
  phone?: string | null
  email?: string | null
  name?: string | null
  city?: string | null
  state?: string | null
  country?: string | null
  zipcode?: string | null
  externalId?: string | null
  rawPayload?: unknown
  productId?: string | null
  productName?: string | null
  transactionId?: string | null
  value?: number | null
  currency?: string
}): CapiPayload {
  const userData: CapiEventPayload['user_data'] = {}
  const ph = hashPhone(params.phone)
  const em = hashEmail(params.email)
  const nameParts = (params.name || '').trim().split(/\s+/).filter(Boolean)
  const fn = hashText(nameParts[0])
  const ln = hashText(nameParts.length > 1 ? nameParts.slice(1).join(' ') : null)
  const ct = hashText(params.city)
  const st = hashText(params.state)
  const zp = hashDigits(params.zipcode)
  const country = hashText(params.country)
  const externalId = hashDigits(params.externalId) ?? hashText(params.externalId)
  const rawAttribution = extractRawAttribution(params.rawPayload)
  if (ph) userData.ph = [ph]
  if (em) userData.em = [em]
  if (fn) userData.fn = [fn]
  if (ln) userData.ln = [ln]
  if (ct) userData.ct = [ct]
  if (st) userData.st = [st]
  if (zp) userData.zp = [zp]
  if (country) userData.country = [country]
  if (externalId) userData.external_id = [externalId]
  if (rawAttribution.fbc) userData.fbc = rawAttribution.fbc
  if (rawAttribution.fbp) userData.fbp = rawAttribution.fbp
  if (rawAttribution.ctwaClid) userData.ctwa_clid = rawAttribution.ctwaClid
  if (rawAttribution.clientIpAddress) userData.client_ip_address = rawAttribution.clientIpAddress
  if (rawAttribution.clientUserAgent) userData.client_user_agent = rawAttribution.clientUserAgent

  const entry: CapiEventPayload = {
    event_name: params.eventName,
    event_time: Math.floor(params.eventTime.getTime() / 1000),
    event_id: params.eventId,
    action_source: 'system_generated',
    user_data: userData,
  }
  const customData: NonNullable<CapiEventPayload['custom_data']> = {}
  // Só entra quando existir valor real: reserva sem transação financeira
  // direta (Gramado) não tem custom_data.value, e a Meta não exige em todo evento.
  if (params.value != null) {
    customData.value = params.value
    customData.currency = params.currency || 'BRL'
  }
  if (params.transactionId) customData.order_id = params.transactionId
  if (params.productId) customData.content_ids = [params.productId]
  if (params.productName) customData.content_name = params.productName
  if (params.productId || params.productName) customData.content_type = 'product'
  if (Object.keys(customData).length > 0) entry.custom_data = customData
  return { data: [entry] }
}

/**
 * Envia um evento de conversão pro Meta. NUNCA lança exceção: todo caminho
 * (config ausente, rede fora, Graph API recusando) devolve {ok:false, error},
 * pra fire-and-forget do lado de quem chama (`sendConversionEvent(...).catch(...)`
 * é só rede de segurança extra, o catch nunca deveria disparar de verdade).
 *
 * Idempotência: grava a linha em meta_conversion_events com status 'pending'
 * ANTES de chamar a Graph API (nunca perde o registro se o processo morrer no
 * meio), e o uniqueIndex(companyId, eventId) garante que o mesmo evento de
 * negócio nunca é mandado duas vezes, mesmo em retry futuro.
 */
async function sendMetaConversionEvent(params: SendConversionEventParams): Promise<SendConversionEventResult> {
  try {
    const eventTime = params.eventTime ?? new Date()
    const phone = params.phone ?? null
    const email = params.email ?? null

    if (!phone && !email) {
      return { ok: false, error: 'evento sem telefone nem e-mail, nada para identificar o cliente em user_data' }
    }

    const [config] = await db.select().from(settings).where(eq(settings.companyId, params.companyId))
    const pixelId = (config?.metaPixelId || '').trim()
    const token = (config?.metaAdsAccessToken || '').trim()
    if (!pixelId || !token) {
      return { ok: false, error: 'empresa sem metaPixelId/metaAdsAccessToken configurado (Conversions API desligada)' }
    }

    try {
      await db.insert(metaConversionEvents).values({
        companyId: params.companyId,
        leadId: params.leadId,
        eventName: params.eventName,
        eventId: params.eventId,
        pixelId,
        status: 'pending',
      })
    } catch (err) {
      if (isUniqueViolation(err)) {
        return { ok: false, error: 'evento já enviado antes (event_id duplicado), não reenviado' }
      }
      return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'falha ao gravar log de envio' }
    }

    const payload = buildCapiPayload({
      eventName: params.eventName,
      eventId: params.eventId,
      eventTime,
      phone,
      email,
      name: params.name,
      city: params.city,
      state: params.state,
      country: params.country,
      zipcode: params.zipcode,
      externalId: params.externalId,
      rawPayload: params.rawPayload,
      productId: params.productId,
      productName: params.productName,
      transactionId: params.transactionId,
      value: params.value ?? null,
      currency: params.currency ?? 'BRL',
    })

    const url = new URL(`${GRAPH_HOST}/${GRAPH_VERSION}/${pixelId}/events`)
    const markSent = (httpStatus: number, metaResponse: unknown) =>
      db.update(metaConversionEvents)
        .set({ status: 'sent', httpStatus, metaResponse, sentAt: new Date(), attempts: sql`${metaConversionEvents.attempts} + 1` })
        .where(and(eq(metaConversionEvents.companyId, params.companyId), eq(metaConversionEvents.eventId, params.eventId)))
        .catch(() => {})
    const markFailed = (httpStatus: number | null, metaResponse: unknown, errorMessage: string) =>
      db.update(metaConversionEvents)
        .set({ status: 'failed', httpStatus: httpStatus ?? undefined, metaResponse, errorMessage, attempts: sql`${metaConversionEvents.attempts} + 1` })
        .where(and(eq(metaConversionEvents.companyId, params.companyId), eq(metaConversionEvents.eventId, params.eventId)))
        .catch(() => {})

    try {
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const data: { error?: { message?: string } } = await res.json().catch(() => ({}))

      if (!res.ok) {
        const errorMessage = (data?.error?.message || `graph ${res.status}`).slice(0, 300)
        await markFailed(res.status, data, errorMessage)
        return { ok: false, error: errorMessage }
      }

      await markSent(res.status, data)
      return { ok: true }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message.slice(0, 300) : 'falha na chamada à Graph API'
      await markFailed(null, null, errorMessage)
      return { ok: false, error: errorMessage }
    }
  } catch (err) {
    // Rede de segurança final: nenhum caminho acima deveria cair aqui, mas
    // "nunca lança exceção pro chamador" é o contrato desta função.
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : 'falha inesperada no envio de conversão' }
  }
}

/**
 * Dispara Meta e GA4 em paralelo. O resultado retornado continua sendo o da
 * Meta para preservar o contrato dos callers; o GA4 tem log e idempotência
 * próprios e nunca bloqueia o atendimento. O Google Ads importa o key event
 * do GA4 manualmente depois, sem uma segunda conversão direta.
 */
export async function sendConversionEvent(params: SendConversionEventParams): Promise<SendConversionEventResult> {
  if (params.eventName === META_EVENT_NAMES.purchase) {
    return { ok: false, error: 'Purchase não é enviado pelo SAC; a compra já é registrada pelo gateway' }
  }
  const [metaResult] = await Promise.all([
    sendMetaConversionEvent(params),
    sendGa4Conversion({
      companyId: params.companyId,
      leadId: params.leadId,
      eventId: params.eventId,
      eventName: params.eventName,
      eventTime: params.eventTime,
      value: params.value,
      currency: params.currency,
      transactionId: params.transactionId,
      productId: params.productId,
      productName: params.productName,
      email: params.email,
      phone: params.phone,
      rawPayload: params.rawPayload,
    }),
  ])
  return metaResult
}
