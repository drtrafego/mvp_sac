import React from 'react'

export type OriginCategory =
  | 'mineracao'
  | 'meta_ads'
  | 'google_ads'
  | 'instagram'
  | 'email'
  | 'checkout'
  | 'organico'
  | 'evento'
  | 'other'

export interface OriginBadgeMeta {
  key: string
  label: string
  shortLabel: string
  category: OriginCategory
  subcategory?: string
  color: string
  badgeColor: string
  textColor: string
  iconName: 'whatsapp' | 'email' | 'instagram' | 'meta' | 'google' | 'hotmart' | 'kiwify' | 'greenn' | 'zouti' | 'direct' | 'mineracao'
}

/**
 * Normaliza e classifica qualquer origem / plataforma / evento do sistema
 * garantindo consistência total entre Dashboard, Origens, Leads, Pipeline e Inbox.
 */
export function normalizeOrigin(
  rawSource: string | null | undefined,
  rawMedium: string | null | undefined = null,
  platform: string | null | undefined = null,
  eventType: string | null | undefined = null
): OriginBadgeMeta {
  const s = (rawSource || '').toLowerCase().trim()
  const m = (rawMedium || '').toLowerCase().trim()
  const p = (platform || '').toLowerCase().trim()
  const ev = (eventType || '').toLowerCase().trim()
  const combined = `${s} ${m} ${p} ${ev}`

  // 1. Mineração (AutonomIA)
  if (
    combined.includes('miner') ||
    combined.includes('mining') ||
    combined.includes('outreach') ||
    combined.includes('prospeccao') ||
    combined.includes('places')
  ) {
    if (combined.includes('email') || combined.includes('mail') || combined.includes('brevo')) {
      return {
        key: 'mineracao_email',
        label: 'Mineração — E-mail Frio (Brevo)',
        shortLabel: 'Mineração E-mail',
        category: 'mineracao',
        subcategory: 'email',
        color: 'bg-indigo-500',
        badgeColor: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-400',
        textColor: 'text-indigo-400',
        iconName: 'email',
      }
    }
    if (combined.includes('ig') || combined.includes('instagram') || combined.includes('direct')) {
      return {
        key: 'mineracao_instagram',
        label: 'Mineração — Instagram Direct',
        shortLabel: 'Mineração IG',
        category: 'mineracao',
        subcategory: 'instagram',
        color: 'bg-pink-500',
        badgeColor: 'border-pink-500/30 bg-pink-500/10 text-pink-400',
        textColor: 'text-pink-400',
        iconName: 'instagram',
      }
    }
    return {
      key: 'mineracao_whatsapp',
      label: 'Mineração — WhatsApp Outreach',
      shortLabel: 'Mineração',
      category: 'mineracao',
      subcategory: 'whatsapp',
      color: 'bg-amber-500',
      badgeColor: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
      textColor: 'text-amber-400',
      iconName: 'mineracao',
    }
  }

  // 2. Meta Ads (Facebook / Instagram Ads / Dr. Lucas)
  if (
    combined.includes('fb') ||
    combined.includes('meta') ||
    combined.includes('facebook') ||
    combined.includes('anuncio') ||
    (combined.includes('ads') && !combined.includes('google'))
  ) {
    if (combined.includes('lucas')) {
      return {
        key: 'meta_ads_lucas',
        label: 'Meta Ads Dr. Lucas',
        shortLabel: 'Meta Ads Dr. Lucas',
        category: 'meta_ads',
        subcategory: 'dr_lucas',
        color: 'bg-blue-500',
        badgeColor: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
        textColor: 'text-blue-400',
        iconName: 'meta',
      }
    }
    if (combined.includes('instagram') || combined.includes('stories') || combined.includes('reels')) {
      return {
        key: 'meta_ads_instagram',
        label: 'Meta Ads — Instagram (Feed & Stories)',
        shortLabel: 'Instagram Ads',
        category: 'meta_ads',
        subcategory: 'instagram_ads',
        color: 'bg-pink-500',
        badgeColor: 'border-pink-500/30 bg-pink-500/10 text-pink-400',
        textColor: 'text-pink-400',
        iconName: 'instagram',
      }
    }
    return {
      key: 'meta_ads_geral',
      label: 'Meta Ads — Facebook & Instagram',
      shortLabel: 'Meta Ads',
      category: 'meta_ads',
      subcategory: 'meta_geral',
      color: 'bg-blue-500',
      badgeColor: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
      textColor: 'text-blue-400',
      iconName: 'meta',
    }
  }

  // 3. Google Ads & YouTube
  if (combined.includes('google') || combined.includes('gads') || combined.includes('youtube') || combined.includes('search')) {
    return {
      key: 'google_ads',
      label: 'Google Ads & YouTube Search',
      shortLabel: 'Google Ads',
      category: 'google_ads',
      subcategory: 'search',
      color: 'bg-red-500',
      badgeColor: 'border-red-500/30 bg-red-500/10 text-red-400',
      textColor: 'text-red-400',
      iconName: 'google',
    }
  }

  // 4. Instagram Direct / Orgânico
  if (combined.includes('instagram') || combined.includes('direct') || combined.includes('ig_direct')) {
    return {
      key: 'instagram_direct',
      label: 'Instagram Direct & DMs',
      shortLabel: 'Instagram Direct',
      category: 'instagram',
      subcategory: 'direct',
      color: 'bg-pink-500',
      badgeColor: 'border-pink-500/30 bg-pink-500/10 text-pink-400',
      textColor: 'text-pink-400',
      iconName: 'instagram',
    }
  }

  // 5. E-mail Marketing / Campanhas
  if (combined.includes('email') || combined.includes('mail') || combined.includes('newsletter') || combined.includes('brevo')) {
    return {
      key: 'email_marketing',
      label: 'E-mail Marketing (Brevo)',
      shortLabel: 'E-mail',
      category: 'email',
      subcategory: 'email',
      color: 'bg-indigo-500',
      badgeColor: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-400',
      textColor: 'text-indigo-400',
      iconName: 'email',
    }
  }

  // 6. Checkouts (Hotmart, Kiwify, Greenn, Zouti)
  if (combined.includes('hotmart') || p === 'hotmart') {
    return {
      key: 'checkout_hotmart',
      label: 'Hotmart Checkout',
      shortLabel: 'Hotmart',
      category: 'checkout',
      subcategory: 'hotmart',
      color: 'bg-orange-500',
      badgeColor: 'border-orange-500/30 bg-orange-500/10 text-orange-400',
      textColor: 'text-orange-400',
      iconName: 'hotmart',
    }
  }
  if (combined.includes('kiwify') || p === 'kiwify') {
    return {
      key: 'checkout_kiwify',
      label: 'Kiwify Checkout',
      shortLabel: 'Kiwify',
      category: 'checkout',
      subcategory: 'kiwify',
      color: 'bg-cyan-500',
      badgeColor: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400',
      textColor: 'text-cyan-400',
      iconName: 'kiwify',
    }
  }
  if (combined.includes('greenn') || p === 'greenn') {
    return {
      key: 'checkout_greenn',
      label: 'Greenn Checkout',
      shortLabel: 'Greenn',
      category: 'checkout',
      subcategory: 'greenn',
      color: 'bg-emerald-500',
      badgeColor: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
      textColor: 'text-emerald-400',
      iconName: 'greenn',
    }
  }
  if (combined.includes('zouti') || p === 'zouti') {
    return {
      key: 'checkout_zouti',
      label: 'Zouti Checkout',
      shortLabel: 'Zouti',
      category: 'checkout',
      subcategory: 'zouti',
      color: 'bg-purple-500',
      badgeColor: 'border-purple-500/30 bg-purple-500/10 text-purple-400',
      textColor: 'text-purple-400',
      iconName: 'zouti',
    }
  }

  // 7. Eventos & Nichos específicos
  if (combined.includes('consulta') || ev === 'consulta_medica') {
    return {
      key: 'evento_consulta',
      label: 'Consulta Médica',
      shortLabel: 'Consulta Médica',
      category: 'evento',
      color: 'bg-cyan-500',
      badgeColor: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400',
      textColor: 'text-cyan-400',
      iconName: 'direct',
    }
  }
  if (combined.includes('reserva') || ev === 'reserva_restaurante') {
    return {
      key: 'evento_reserva',
      label: 'Reserva Restaurante',
      shortLabel: 'Reserva Restaurante',
      category: 'evento',
      color: 'bg-amber-500',
      badgeColor: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
      textColor: 'text-amber-400',
      iconName: 'whatsapp',
    }
  }

  // 8. Padrão / Direto / Orgânico
  if (!rawSource && !platform) {
    return {
      key: 'organico_direto',
      label: 'Direto / Link da Bio',
      shortLabel: 'Direto',
      category: 'organico',
      subcategory: 'direto',
      color: 'bg-teal-500',
      badgeColor: 'border-teal-500/30 bg-teal-500/10 text-teal-400',
      textColor: 'text-teal-400',
      iconName: 'direct',
    }
  }

  const cleaned = (rawSource || platform || 'SAC').replace(/[_-]/g, ' ').trim()
  const title = cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
  return {
    key: `custom_${s || p}`,
    label: title,
    shortLabel: title,
    category: 'other',
    color: 'bg-fg-subtle',
    badgeColor: 'border-line-subtle bg-surface-raised text-fg-subtle',
    textColor: 'text-fg-subtle',
    iconName: 'direct',
  }
}

/**
 * Retorna todos os badges normalizados e deduplicados para um contato / lead
 */
export function extractLeadOrigins(lead: {
  trackingSource?: string | null
  platform?: string | null
  utmCampaign?: string | null
  utmMedium?: string | null
  eventType?: string | null
  channel?: string | null
  allOrigins?: string[] | null
  allEventTypes?: string[] | null
}): OriginBadgeMeta[] {
  const result: OriginBadgeMeta[] = []
  const seenKeys = new Set<string>()

  const candidates: { source?: string | null; medium?: string | null; platform?: string | null; eventType?: string | null }[] = []

  // 1. Array consolidado de origens se houver deduplicação
  if (lead.allOrigins && lead.allOrigins.length > 0) {
    for (const org of lead.allOrigins) {
      candidates.push({ source: org, platform: lead.platform, medium: lead.utmMedium, eventType: lead.eventType })
    }
  } else {
    if (lead.trackingSource) candidates.push({ source: lead.trackingSource, medium: lead.utmMedium })
    if (lead.platform && lead.platform !== lead.trackingSource) candidates.push({ platform: lead.platform })
  }

  if (lead.eventType && !['whatsapp', 'chat', 'direct'].includes(lead.eventType.toLowerCase())) {
    candidates.push({ eventType: lead.eventType })
  }

  if (candidates.length === 0) {
    candidates.push({ source: 'Direto' })
  }

  for (const c of candidates) {
    const meta = normalizeOrigin(c.source, c.medium, c.platform, c.eventType)
    if (!seenKeys.has(meta.key)) {
      seenKeys.add(meta.key)
      result.push(meta)
    }
  }

  return result
}
