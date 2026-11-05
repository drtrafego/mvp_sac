import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { leadTags, recoveryLeads } from '@/lib/db/schema'

/** Nome canônico usado pela taxonomia de tags do SAC para tráfego pago Meta. */
export const META_AD_TAG = 'anuncio'
export const META_AD_TAG_CREATED_BY = 'system:meta_ads'

export interface MetaAdsEvidence {
  trackingSource?: string | null
  platform?: string | null
  eventType?: string | null
  metaCampaignId?: string | null
  metaAdsetId?: string | null
  metaAdId?: string | null
  metaFormId?: string | null
  metaLeadgenId?: string | null
  rawPayload?: unknown
}

export interface MetaLeadIdentifiers {
  formId: string | null
  leadgenId: string | null
}

function normalized(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase()
}

function present(value: string | null | undefined): boolean {
  return Boolean(value && value.trim())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function firstNestedText(value: unknown, keys: string[], depth = 0): string | null {
  if (depth > 6) return null
  if (Array.isArray(value)) {
    for (const child of value) {
      const result = firstNestedText(child, keys, depth + 1)
      if (result) return result
    }
    return null
  }
  if (!isRecord(value)) return null
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      const result = String(candidate).trim()
      if (result) return result
    }
  }
  for (const child of Object.values(value)) {
    const result = firstNestedText(child, keys, depth + 1)
    if (result) return result
  }
  return null
}

/** Extrai apenas os IDs públicos de Lead Ads, sem copiar campos de contato. */
export function extractMetaLeadIdentifiers(payload: unknown): MetaLeadIdentifiers {
  return {
    formId: firstNestedText(payload, ['form_id', 'formId']),
    leadgenId: firstNestedText(payload, ['leadgen_id', 'leadgenId']),
  }
}

/**
 * Classifica somente sinais que o SAC já trata como atribuição paga.
 * Canal WhatsApp/Instagram, campanha textual ou nome de anúncio isolado não
 * são prova e ficam deliberadamente fora desta função.
 */
export function isProvenMetaAdsEvidence(input: MetaAdsEvidence): boolean {
  const source = normalized(input.trackingSource)
  const platform = normalized(input.platform)

  if (['meta_ads', 'instagram_ad', 'ig_ad', 'nina_anuncio'].includes(source)) return true
  if (platform === 'meta_lead_ads') return true
  if (present(input.metaCampaignId) || present(input.metaAdsetId) || present(input.metaAdId)) return true
  if (present(input.metaFormId) || present(input.metaLeadgenId)) return true

  const payload = input.rawPayload
  if (!isRecord(payload)) return false

  const payloadIdentifiers = extractMetaLeadIdentifiers(payload)
  if (payloadIdentifiers.formId || payloadIdentifiers.leadgenId) return true

  if (payload.source === 'ctwa_referrals') {
    const referral = isRecord(payload.referral) ? payload.referral : null
    return Boolean(referral && (
      present(typeof referral.source_id === 'string' ? referral.source_id : null) ||
      present(typeof referral.ctwa_clid === 'string' ? referral.ctwa_clid : null)
    ))
  }

  const referral = isRecord(payload.referral) ? payload.referral : null
  const adsContext = referral && isRecord(referral.ads_context_data) ? referral.ads_context_data : null
  return Boolean(
    referral && (
      referral.source === 'ADS' ||
      present(typeof referral.ad_id === 'string' ? referral.ad_id : null) ||
      Boolean(adsContext && present(typeof adsContext.ad_id === 'string' ? adsContext.ad_id : null))
    )
  )
}

export type MetaAdsTagResult = {
  applied: boolean
  reason?: 'lead_not_found' | 'not_proven' | 'tag_persist_failed'
  error?: string
}

/**
 * Reconfere o lead dentro do tenant antes de escrever. A constraint única de
 * lead_tags e onConflictDoNothing tornam a operação segura para retries e
 * duas sincronizações concorrentes; tags já existentes nunca são removidas.
 */
export async function ensureMetaAdsTagForLead({
  companyId,
  leadId,
  evidence = {},
}: {
  companyId: number
  leadId: number
  evidence?: MetaAdsEvidence
}): Promise<MetaAdsTagResult> {
  try {
    const [lead] = await db
      .select({
        id: recoveryLeads.id,
        trackingSource: recoveryLeads.trackingSource,
        platform: recoveryLeads.platform,
        eventType: recoveryLeads.eventType,
        metaCampaignId: recoveryLeads.metaCampaignId,
        metaAdsetId: recoveryLeads.metaAdsetId,
        metaAdId: recoveryLeads.metaAdId,
        metaFormId: recoveryLeads.metaFormId,
        metaLeadgenId: recoveryLeads.metaLeadgenId,
        rawPayload: recoveryLeads.rawPayload,
      })
      .from(recoveryLeads)
      .where(and(eq(recoveryLeads.id, leadId), eq(recoveryLeads.companyId, companyId)))
      .limit(1)

    if (!lead) return { applied: false, reason: 'lead_not_found' }

    const proven = isProvenMetaAdsEvidence({
      ...lead,
      ...evidence,
      rawPayload: evidence.rawPayload ?? lead.rawPayload,
    })
    if (!proven) return { applied: false, reason: 'not_proven' }

    const [inserted] = await db
      .insert(leadTags)
      .values({ leadId, tag: META_AD_TAG, scopeChannel: null, createdBy: META_AD_TAG_CREATED_BY })
      .onConflictDoNothing()
      .returning({ id: leadTags.id })

    return { applied: Boolean(inserted?.id) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { applied: false, reason: 'tag_persist_failed', error: message.slice(0, 240) }
  }
}
