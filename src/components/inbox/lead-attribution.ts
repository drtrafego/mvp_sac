export interface LeadAttributionInput {
  platform?: string | null
  channel?: string | null
  trackingSource?: string | null
  utmCampaign?: string | null
  adsetName?: string | null
  adName?: string | null
  metaCampaignId?: string | null
  metaAdsetId?: string | null
  metaAdId?: string | null
  metaFormId?: string | null
  metaLeadgenId?: string | null
}

export interface LeadAttributionRow {
  key: string
  label: string
  value: string
  available: boolean
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

function idValue(name: string | null, id: string | null): string {
  if (name && id) return `${name} · ID ${id}`
  return name || (id ? `ID ${id}` : 'Não informado')
}

function normalize(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase()
}

function originLabel(input: LeadAttributionInput, paid: boolean): string {
  const source = normalize(input.trackingSource)
  if (source === 'meta_messaging_unattributed') return 'Meta Messaging · origem não atribuída'
  if (paid) return 'Meta Ads'
  if (source === 'instagram_direct' || source === 'ig_direct') return 'Instagram Direct'
  if (source === 'whatsapp_direto' || source === 'whatsapp') return 'WhatsApp direto'
  if (source === 'google_ads') return 'Google Ads'
  if (source === 'mineracao_prospeccao' || source === 'mineracao') return 'Mineração'
  return source ? 'Origem registrada' : 'Não informado'
}

function platformLabel(value: string | null | undefined): string {
  const platform = normalize(value)
  if (platform === 'meta_lead_ads') return 'Meta Lead Ads'
  if (platform === 'instagram' || platform === 'instagram_direct') return 'Instagram'
  if (platform === 'whatsapp' || platform === 'whatsapp_official' || platform === 'meta') return 'WhatsApp'
  if (platform === 'email' || platform === 'brevo') return 'E-mail'
  if (platform === 'sac') return 'SAC'
  return value?.trim() || 'Não informado'
}

export function buildLeadAttributionRows(input: LeadAttributionInput): LeadAttributionRow[] {
  const source = normalize(input.trackingSource)
  const platform = normalize(input.platform)
  const campaign = clean(input.utmCampaign)
  const adset = clean(input.adsetName)
  const ad = clean(input.adName)
  const campaignId = clean(input.metaCampaignId)
  const adsetId = clean(input.metaAdsetId)
  const adId = clean(input.metaAdId)
  const formId = clean(input.metaFormId)
  const leadgenId = clean(input.metaLeadgenId)
  const paid = source === 'meta_ads'
    || source === 'instagram_ad'
    || source === 'ig_ad'
    || source === 'nina_anuncio'
    || platform === 'meta_lead_ads'
    || Boolean(campaignId || adsetId || adId || formId || leadgenId)

  return [
    { key: 'origin', label: 'Origem', value: originLabel(input, paid), available: Boolean(source || paid) },
    { key: 'platform', label: 'Plataforma', value: platformLabel(input.platform), available: Boolean(input.platform) },
    { key: 'channel', label: 'Canal de abordagem', value: input.channel?.trim() || 'Não informado', available: Boolean(input.channel) },
    { key: 'campaign', label: 'Campanha', value: idValue(campaign, campaignId), available: Boolean(campaign || campaignId) },
    { key: 'adset', label: 'Conjunto', value: idValue(adset, adsetId), available: Boolean(adset || adsetId) },
    { key: 'ad', label: 'Anúncio', value: idValue(ad, adId), available: Boolean(ad || adId) },
    { key: 'form', label: 'Formulário', value: formId || 'Não informado', available: Boolean(formId) },
    { key: 'leadgen', label: 'Leadgen', value: leadgenId || 'Não informado', available: Boolean(leadgenId) },
  ]
}
