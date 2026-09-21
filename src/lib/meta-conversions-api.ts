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
 * Hoje (21/09/2026) só os 4 webhooks de checkout (Hotmart, Greenn, Zouti,
 * Kiwify) chamam sendConversionEvent(), com eventName: 'Purchase'. O Gramado
 * Plazza (e qualquer cliente que confirma por reserva/agendamento, não por
 * checkout) ainda NÃO chama esta função: depende da sincronização de
 * conversas do Gramado (ainda não construída) trazer um sinal estruturado de
 * "reserva confirmada" pro SAC — ver operacao/meta-conversions-api-20260921.md,
 * seção 1.2. A função já está pronta para esse uso (eventName: 'Schedule'),
 * só falta ligar quando aquele sinal existir. Não adicionar nenhum
 * `if (slug === 'gramado')`: o desenho é "liga sozinho quando a empresa
 * configura o pixel", igual ads-attribution.ts.
 */

import { and, eq, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import { metaConversionEvents, settings } from '@/lib/db/schema'
import { isUniqueViolation } from '@/lib/webhook-dedup'

const GRAPH_VERSION = (process.env.META_GRAPH_VERSION || 'v21.0').trim()
const GRAPH_HOST = 'https://graph.facebook.com'
const REQUEST_TIMEOUT_MS = 15000

export type MetaConversionEventName = 'Purchase' | 'Schedule'

export interface SendConversionEventParams {
  companyId: number
  leadId: number | null
  eventName: MetaConversionEventName
  /** Determinístico e reproduzível: ver purchaseEventId()/scheduleEventId() abaixo. */
  eventId: string
  phone?: string | null
  email?: string | null
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
  user_data: { ph?: string[]; em?: string[] }
  custom_data?: { value: number; currency: string }
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
  value?: number | null
  currency?: string
}): CapiPayload {
  const userData: CapiEventPayload['user_data'] = {}
  const ph = hashPhone(params.phone)
  const em = hashEmail(params.email)
  if (ph) userData.ph = [ph]
  if (em) userData.em = [em]

  const entry: CapiEventPayload = {
    event_name: params.eventName,
    event_time: Math.floor(params.eventTime.getTime() / 1000),
    event_id: params.eventId,
    action_source: 'system_generated',
    user_data: userData,
  }
  // Só entra quando existir valor real: reserva sem transação financeira
  // direta (Gramado) não tem custom_data.value, e a Meta não exige em todo evento.
  if (params.value != null) {
    entry.custom_data = { value: params.value, currency: params.currency || 'BRL' }
  }
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
export async function sendConversionEvent(params: SendConversionEventParams): Promise<SendConversionEventResult> {
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
