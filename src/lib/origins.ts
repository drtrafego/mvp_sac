export type OriginCategory =
  | 'mineracao'
  | 'anuncio'
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
  eventType: string | null | undefined = null,
  channel: string | null | undefined = null
): OriginBadgeMeta {
  const s = (rawSource || '').toLowerCase().trim()
  const m = (rawMedium || '').toLowerCase().trim()
  const p = (platform || '').toLowerCase().trim()
  const ev = (eventType || '').toLowerCase().trim()
  const ch = (channel || '').toLowerCase().trim()
  const combined = `${s} ${m} ${p} ${ev}`

  // Borda de palavra (só do lado ESQUERDO) pro bloco de Mineração abaixo.
  // Mesma correção e mesma justificativa de src/lib/inbox-channel-filter.ts
  // (ruleConditionSql/wordBoundaryPattern): ILIKE/`.includes()` por
  // substring solta colide com texto livre de terceiros (trackingSource dos
  // 4 checkouts, controlado pelo afiliado). Ex. real confirmado pelo QA:
  // "hotmart_marketplaces_afiliados" batia em 'places', "facebook_ads_
  // examiner_leads" batia em 'miner'. Borda só à esquerda porque o valor
  // canônico real "Minerador" (gravado por sync-agents.ts) tem 'miner' como
  // PREFIXO de palavra maior, não palavra isolada: borda dos dois lados
  // quebraria esse caso de novo. `\b` do JS NÃO serve aqui porque trata `_`
  // como caractere de palavra, e os valores reais usam `_` como separador
  // (ex.: "prospeccao_email_followup") — por isso `[^a-z]` explícito, igual
  // ao SQL do outro arquivo.
  const hasWordBoundary = (needle: string) => {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z])${escaped}`, 'i').test(combined)
  }
  const hasAnyWordBoundary = (needles: string[]) => needles.some(hasWordBoundary)

  const hasGoogleAdsSignal = () =>
    hasAnyWordBoundary(['google_ads', 'gclid', 'adwords', 'gads', 'google'])

  const hasMetaAdsSignal = () =>
    hasAnyWordBoundary(['meta_ads', 'fb_ads', 'facebook_ads', 'meta', 'facebook', 'fb', 'anuncio', 'ads'])

  // Regra prioritária de proteção médica / Dr. Lucas: NUNCA é Mineração
  const isDrLucas = combined.includes('lucas') || combined.includes('clara') || combined.includes('fernandes') || combined.includes('clinica') || combined.includes('consultorio')
  if (isDrLucas) {
    if (hasMetaAdsSignal()) {
      return {
        key: 'meta_ads_lucas',
        label: 'Meta Ads Dr. Lucas',
        shortLabel: 'Meta Ads Dr. Lucas',
        category: 'anuncio',
        subcategory: 'meta_ads',
        color: 'bg-blue-500',
        badgeColor: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
        textColor: 'text-blue-400',
        iconName: 'meta',
      }
    }
    return {
      key: 'whatsapp_sac_lucas',
      label: 'WhatsApp (Consultório Dr. Lucas)',
      shortLabel: 'WhatsApp SAC',
      category: 'organico',
      subcategory: 'sac',
      color: 'bg-emerald-500',
      badgeColor: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
      textColor: 'text-emerald-400',
      iconName: 'whatsapp',
    }
  }

  // 1. Mineração (AutonomIA) - Apenas para empresas de prospecção fria real
  if (
    hasWordBoundary('miner') ||
    hasWordBoundary('mining') ||
    hasWordBoundary('prospeccao') ||
    hasWordBoundary('places')
  ) {
    // Sinal primário: a coluna `channel` de recoveryLeads (mesma fonte de
    // verdade que o inbox-channel-filter.ts usa). O sync de mineração
    // (sync-agents.ts, bloco 4) grava trackingSource/platform com constantes
    // fixas ("mineracao_prospeccao"/"sac") pra TODO lead do pipeline, então
    // o texto livre de trackingSource/platform/eventType nunca diferencia
    // e-mail de Instagram de WhatsApp. Quem diferencia é `channel`
    // ('email'|'instagram'|'whatsapp'), setado corretamente por lead desde o
    // sync. Texto livre fica como sinal SECUNDÁRIO (OR), pra não regredir
    // nenhum caso que hoje já funciona via UTM (utm_medium=email/instagram).
    if (ch === 'email' || combined.includes('email') || combined.includes('mail') || combined.includes('brevo')) {
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
    if (ch === 'instagram' || combined.includes('ig') || combined.includes('instagram') || combined.includes('direct')) {
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

  // 2. Anúncio (Meta Ads / Google Ads)
  //
  // Mantém a mesma precedência de src/lib/inbox-channel-filter.ts:
  // mineração já venceu acima, e só depois tráfego pago vence colisões com
  // canais orgânicos como "instagram_ads_agosto". Todas as buscas novas usam
  // a borda à esquerda (`hasWordBoundary`), não `.includes()` solto.
  if (combined.includes('instagram_ad') || combined.includes('ig_ad') || hasGoogleAdsSignal() || hasMetaAdsSignal()) {
    if (hasGoogleAdsSignal()) {
      return {
        key: 'google_ads',
        label: 'Google Ads & Search',
        shortLabel: 'Google Ads',
        category: 'anuncio',
        subcategory: 'google_ads',
        color: 'bg-red-500',
        badgeColor: 'border-red-500/30 bg-red-500/10 text-red-400',
        textColor: 'text-red-400',
        iconName: 'google',
      }
    }
    if (combined.includes('lucas')) {
      return {
        key: 'meta_ads_lucas',
        label: 'Meta Ads Dr. Lucas',
        shortLabel: 'Meta Ads Dr. Lucas',
        category: 'anuncio',
        subcategory: 'meta_ads',
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
        category: 'anuncio',
        subcategory: 'meta_ads',
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
      category: 'anuncio',
      subcategory: 'meta_ads',
      color: 'bg-blue-500',
      badgeColor: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
      textColor: 'text-blue-400',
      iconName: 'meta',
    }
  }

  // 3. Instagram Direct / Orgânico / Comentários
  if (combined.includes('instagram_comment') || combined.includes('ig_comment') || combined.includes('comentario') || combined.includes('comment')) {
    return {
      key: 'instagram_comment',
      label: 'Instagram (Comentário)',
      shortLabel: 'IG Comentário',
      category: 'instagram',
      subcategory: 'comment',
      color: 'bg-purple-500',
      badgeColor: 'border-purple-500/30 bg-purple-500/10 text-purple-400',
      textColor: 'text-purple-400',
      iconName: 'instagram',
    }
  }

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

  // 4. E-mail Marketing / Campanhas
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

  // 5. Checkouts (Hotmart, Kiwify, Greenn, Zouti)
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

  // 6. Eventos & Nichos específicos
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

  // 7. Padrão / Direto / Orgânico
  // SAC e WhatsApp sao dimensoes diferentes: SAC e a origem/plataforma do
  // atendimento no painel, WhatsApp e o canal de contato. Quando todos chegam
  // por channel='whatsapp', nao rotule a origem como WhatsApp nem jogue em
  // "other"; preserve SAC como origem e deixe o ChannelBadge mostrar WhatsApp.
  if (p === 'sac' || s === 'agente_ia' || s === 'whatsapp_sac') {
    return {
      key: 'sac_atendimento',
      label: 'SAC',
      shortLabel: 'SAC',
      category: 'organico',
      subcategory: 'sac',
      color: 'bg-emerald-500',
      badgeColor: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
      textColor: 'text-emerald-400',
      iconName: 'whatsapp',
    }
  }

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
    const meta = normalizeOrigin(c.source, c.medium, c.platform, c.eventType, lead.channel)
    if (!seenKeys.has(meta.key)) {
      seenKeys.add(meta.key)
      result.push(meta)
    }
  }

  return result
}
