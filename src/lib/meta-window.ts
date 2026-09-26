// Regra de negócio da janela de 24h da Meta (WhatsApp Business API).
// Fora da janela desde a última mensagem RECEBIDA do lead (inbound), a Meta
// exige template aprovado; mensagem livre é recusada (ou pior, some
// silenciosamente em algum canal). Extraído de
// src/components/inbox/MetaWindowBadge.tsx pra ser reaproveitado também no
// servidor (executor da fila em src/app/api/cron/route.ts), sem duplicar a
// regra em dois lugares que podem divergir.

export interface MetaWindowInfo {
  type: 'ad_72h' | 'standard_24h'
  typeLabel: string
  status: 'active' | 'expiring_soon' | 'expired' | 'waiting_user'
  remainingMs: number
  remainingHours: number
  remainingMinutes: number
  text: string
  badgeClass: string
  requiresTemplate: boolean
  isAd: boolean
  windowHours: number
}

export function getMetaWindowInfo(lead: {
  trackingSource?: string | null
  eventType?: string | null
  utmCampaign?: string | null
  lastInboundAt?: string | null
  lastMessageAt?: string | null
  lastDirection?: string | null
}): MetaWindowInfo {
  const windowHours = 24
  const typeLabel = '24h Atendimento'
  const windowDurationMs = 24 * 3600 * 1000

  // 1. Se ainda não há mensagem enviada pelo cliente (apenas mensagens nossas outbound)
  if (!lead.lastInboundAt) {
    return {
      type: 'standard_24h',
      typeLabel,
      status: 'waiting_user',
      remainingMs: 0,
      remainingHours: 0,
      remainingMinutes: 0,
      text: '📨 Aguardando resposta do cliente',
      badgeClass: 'bg-surface-inset text-fg-subtle border-line-subtle',
      requiresTemplate: true,
      isAd: false,
      windowHours,
    }
  }

  // 2. Cálculo estrito de 24 horas a partir da última mensagem recebida DA PESSOA (inbound)
  const inboundTime = new Date(lead.lastInboundAt).getTime()
  if (isNaN(inboundTime)) {
    return {
      type: 'standard_24h',
      typeLabel,
      status: 'waiting_user',
      remainingMs: 0,
      remainingHours: 0,
      remainingMinutes: 0,
      text: '📨 Aguardando resposta do cliente',
      badgeClass: 'bg-surface-inset text-fg-subtle border-line-subtle',
      requiresTemplate: true,
      isAd: false,
      windowHours,
    }
  }

  const expiresAt = inboundTime + windowDurationMs
  const remainingMs = expiresAt - Date.now()

  // 3. Janela Expirada (> 24h desde a última mensagem da pessoa)
  if (remainingMs <= 0) {
    return {
      type: 'standard_24h',
      typeLabel,
      status: 'expired',
      remainingMs,
      remainingHours: 0,
      remainingMinutes: 0,
      text: '🔒 Janela 24h fechada (Exige Template)',
      badgeClass: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30 font-semibold',
      requiresTemplate: true,
      isAd: false,
      windowHours,
    }
  }

  const totalMins = Math.floor(remainingMs / 60_000)
  const hours = Math.floor(totalMins / 60)
  const minutes = totalMins % 60

  // 4. Expirando em breve (< 4 horas restantes)
  if (hours < 4) {
    return {
      type: 'standard_24h',
      typeLabel,
      status: 'expiring_soon',
      remainingMs,
      remainingHours: hours,
      remainingMinutes: minutes,
      text: `⚠️ Janela 24h · ${hours}h ${minutes}m rest.`,
      badgeClass: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30 font-bold animate-pulse',
      requiresTemplate: false,
      isAd: false,
      windowHours,
    }
  }

  // 5. Janela Ativa (Dentro das 24h da última mensagem do cliente)
  return {
    type: 'standard_24h',
    typeLabel,
    status: 'active',
    remainingMs,
    remainingHours: hours,
    remainingMinutes: minutes,
    text: `⏱️ Janela 24h · ${hours}h ${minutes}m rest.`,
    badgeClass: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 font-medium',
    requiresTemplate: false,
    isAd: false,
    windowHours,
  }
}
