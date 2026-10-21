/**
 * Google Analytics 4 Measurement Protocol sender.
 *
 * The SAC keeps the business conversion idempotency in its own table and
 * sends one recommended GA4 event per confirmed business conversion. Google
 * Ads imports the resulting GA4 key event manually; this sender never calls
 * the Google Ads API directly.
 */

import { and, eq, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import { ga4ConversionEvents, recoveryLeads, settings } from '@/lib/db/schema'
import { isUniqueViolation } from '@/lib/webhook-dedup'

const COLLECT_HOST = 'https://www.google-analytics.com'
const REQUEST_TIMEOUT_MS = 15000

export const GA4_EVENT_NAMES = {
  purchase: 'purchase',
  appointment: 'generate_lead',
} as const

export type Ga4RecommendedEventName = (typeof GA4_EVENT_NAMES)[keyof typeof GA4_EVENT_NAMES]

export type Ga4SourceEventName = 'Purchase' | 'Schedule'

export function ga4EventNameForSource(eventName: Ga4SourceEventName): Ga4RecommendedEventName {
  return eventName === 'Purchase' ? GA4_EVENT_NAMES.purchase : GA4_EVENT_NAMES.appointment
}

type Ga4Scalar = string | number

export interface Ga4EventPayload {
  client_id: string
  user_id?: string
  timestamp_micros?: number
  events: Array<{
    name: Ga4RecommendedEventName
    params: Record<string, Ga4Scalar>
  }>
}

export interface BuildGa4PayloadParams {
  companyId: number
  leadId: number | null
  eventId: string
  eventName: Ga4SourceEventName
  eventTime: Date
  clientId?: string | null
  sessionId?: string | null
  email?: string | null
  phone?: string | null
  value?: number | null
  currency?: string | null
  transactionId?: string | null
  productId?: string | null
  productName?: string | null
  source?: string | null
  campaign?: string | null
  gclid?: string | null
  gbraid?: string | null
  wbraid?: string | null
}

export interface SendGa4ConversionParams extends Omit<BuildGa4PayloadParams, 'eventTime'> {
  eventTime?: Date
  rawPayload?: unknown
}

export type SendGa4ConversionResult =
  | { ok: true }
  | { ok: false; skipped: true; error: string }
  | { ok: false; skipped?: false; error: string }

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
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
    if (keys.includes(key.toLowerCase()) && typeof value === 'string' && value.trim()) return value.trim()
  }
  for (const value of Object.values(object)) {
    const found = firstPayloadValue(value, keys, depth + 1)
    if (found) return found
  }
  return null
}

/** GA4's web client_id is represented as two numeric components. */
export function deterministicClientId(companyId: number, leadId: number | null, eventId: string): string {
  const digits = sha256(`${companyId}:${leadId ?? ''}:${eventId}`).replace(/\D/g, '').padEnd(30, '0')
  return `${digits.slice(0, 15)}.${digits.slice(15, 30)}`
}

function hashedUserId(email?: string | null, phone?: string | null): string | null {
  const normalizedEmail = (email || '').trim().toLowerCase()
  const normalizedPhone = (phone || '').replace(/\D/g, '')
  const source = normalizedEmail || normalizedPhone
  return source ? sha256(source) : null
}

function addText(params: Record<string, Ga4Scalar>, key: string, value: string | null | undefined): void {
  const clean = value?.trim()
  if (clean) params[key] = clean
}

/** Pure payload builder. It intentionally contains no credentials or PII. */
export function buildGa4Payload(params: BuildGa4PayloadParams): Ga4EventPayload {
  const clientId = params.clientId?.trim() || deterministicClientId(params.companyId, params.leadId, params.eventId)
  const eventParams: Record<string, Ga4Scalar> = {
    engagement_time_msec: 1,
    event_id: params.eventId,
  }

  if (params.value != null) eventParams.value = params.value
  if (params.value != null || params.currency) eventParams.currency = params.currency || 'BRL'
  addText(eventParams, 'transaction_id', params.transactionId)
  addText(eventParams, 'session_id', params.sessionId)
  addText(eventParams, 'item_id', params.productId)
  addText(eventParams, 'item_name', params.productName)
  addText(eventParams, 'lead_source', params.source)
  addText(eventParams, 'campaign', params.campaign)
  addText(eventParams, 'gclid', params.gclid)
  addText(eventParams, 'gbraid', params.gbraid)
  addText(eventParams, 'wbraid', params.wbraid)
  if (params.eventName === 'Schedule') eventParams.lead_type = 'appointment'

  const userId = hashedUserId(params.email, params.phone)
  const payload: Ga4EventPayload = {
    client_id: clientId,
    timestamp_micros: Math.floor(params.eventTime.getTime() * 1000),
    events: [{ name: ga4EventNameForSource(params.eventName), params: eventParams }],
  }
  if (userId) payload.user_id = userId
  return payload
}

export function buildGa4CollectUrl(measurementId: string, apiSecret: string, debug = false): string {
  const endpoint = debug ? `${COLLECT_HOST}/debug/mp/collect` : `${COLLECT_HOST}/mp/collect`
  const url = new URL(endpoint)
  url.searchParams.set('measurement_id', measurementId.trim())
  url.searchParams.set('api_secret', apiSecret.trim())
  return url.toString()
}

function responseBody(value: string): unknown {
  if (!value) return null
  try { return JSON.parse(value) } catch { return { raw: value.slice(0, 500) } }
}

/**
 * Sends one event and records the result. `debug: true` is intentionally
 * available for local validation against Google's debug endpoint; callers in
 * production leave it false so the event is actually collected.
 */
export async function sendGa4Conversion(
  params: SendGa4ConversionParams,
  options: { debug?: boolean } = {},
): Promise<SendGa4ConversionResult> {
  try {
    const [config] = await db.select().from(settings).where(eq(settings.companyId, params.companyId))
    if (!config?.ga4Enabled) return { ok: false, skipped: true, error: 'GA4 Measurement Protocol desativado para a empresa' }

    const measurementId = (config.ga4MeasurementId || '').trim()
    const apiSecret = (config.ga4ApiSecret || '').trim()
    if (!measurementId || !apiSecret) {
      return { ok: false, skipped: true, error: 'GA4 incompleto: Measurement ID e API Secret são obrigatórios' }
    }

    const [lead] = params.leadId == null
      ? []
      : await db.select({
          email: recoveryLeads.email,
          phone: recoveryLeads.phone,
          trackingSource: recoveryLeads.trackingSource,
          utmCampaign: recoveryLeads.utmCampaign,
          googleClickId: recoveryLeads.googleClickId,
          googleGbraid: recoveryLeads.googleGbraid,
          googleWbraid: recoveryLeads.googleWbraid,
        }).from(recoveryLeads)
        .where(and(eq(recoveryLeads.id, params.leadId), eq(recoveryLeads.companyId, params.companyId)))
        .limit(1)

    const email = params.email || lead?.email || null
    const phone = params.phone || lead?.phone || null
    const rawGclid = firstPayloadValue(params.rawPayload, ['gclid'])
    const rawGbraid = firstPayloadValue(params.rawPayload, ['gbraid'])
    const rawWbraid = firstPayloadValue(params.rawPayload, ['wbraid'])
    const rawClientId = firstPayloadValue(params.rawPayload, ['client_id', 'clientid'])
    const rawSessionId = firstPayloadValue(params.rawPayload, ['session_id', 'sessionid'])
    const payload = buildGa4Payload({
      ...params,
      eventTime: params.eventTime ?? new Date(),
      clientId: params.clientId || rawClientId,
      sessionId: params.sessionId || rawSessionId,
      email,
      phone,
      source: params.source || lead?.trackingSource || null,
      campaign: params.campaign || lead?.utmCampaign || null,
      gclid: params.gclid || rawGclid || lead?.googleClickId || null,
      gbraid: params.gbraid || rawGbraid || lead?.googleGbraid || null,
      wbraid: params.wbraid || rawWbraid || lead?.googleWbraid || null,
    })

    try {
      await db.insert(ga4ConversionEvents).values({
        companyId: params.companyId,
        leadId: params.leadId,
        eventId: params.eventId,
        eventName: payload.events[0].name,
        measurementId,
        status: 'pending',
      })
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false, error: 'evento GA4 já enviado antes (event_id duplicado)' }
      return { ok: false, error: error instanceof Error ? error.message.slice(0, 240) : 'falha ao gravar log GA4' }
    }

    const mark = (status: 'sent' | 'failed', httpStatus: number | null, body: unknown, errorMessage?: string) =>
      db.update(ga4ConversionEvents).set({
        status,
        httpStatus: httpStatus ?? undefined,
        ga4Response: body,
        errorMessage,
        sentAt: status === 'sent' ? new Date() : undefined,
        attempts: sql`${ga4ConversionEvents.attempts} + 1`,
      }).where(and(eq(ga4ConversionEvents.companyId, params.companyId), eq(ga4ConversionEvents.eventId, params.eventId))).catch(() => {})

    try {
      const response = await fetch(buildGa4CollectUrl(measurementId, apiSecret, options.debug === true), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const bodyText = await response.text().catch(() => '')
      const body = responseBody(bodyText)
      if (!response.ok) {
        const errorMessage = (typeof body === 'object' && body && 'validationMessages' in body
          ? JSON.stringify((body as { validationMessages?: unknown }).validationMessages)
          : `GA4 Measurement Protocol ${response.status}`).slice(0, 300)
        await mark('failed', response.status, body, errorMessage)
        return { ok: false, error: errorMessage }
      }
      await mark('sent', response.status, body)
      return { ok: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message.slice(0, 300) : 'falha na chamada ao GA4'
      await mark('failed', null, null, errorMessage)
      return { ok: false, error: errorMessage }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 300) : 'falha inesperada no envio ao GA4' }
  }
}
