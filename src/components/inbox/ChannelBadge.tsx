'use client'

import React from 'react'
import {
  MessageCircle,
  Mail,
  Sparkles,
  Bot,
  UserCog,
  CheckCircle2,
  Clock,
  Zap,
  ShoppingBag,
  Send,
  Pickaxe,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export type ChannelType = 'whatsapp' | 'whatsapp_official' | 'whatsapp_uazapi' | 'instagram' | 'email' | 'mineracao' | string

export function MetaInfinityIcon({ size = 13, className = 'text-sky-400' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={cn('shrink-0', className)}>
      <path d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.26-8-12.355-8-5.096 0-5.096 8 0 8 5.095 0 7.26-8 12.355-8z" />
    </svg>
  )
}

export function InstagramLogoIcon({ size = 13, className = 'text-pink-500' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cn('shrink-0', className)}>
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
    </svg>
  )
}

export function ChannelIcon({
  channel,
  size = 14,
  className,
}: {
  channel: ChannelType | null | undefined
  size?: number
  className?: string
}) {
  const norm = (channel || 'whatsapp').toLowerCase()

  if (norm === 'instagram' || norm === 'instagram_direct') {
    return <InstagramLogoIcon size={size} className={cn('text-pink-500 shrink-0', className)} />
  }

  if (norm === 'email' || norm === 'e-mail' || norm === 'brevo') {
    return <Mail size={size} className={cn('text-indigo-500 dark:text-indigo-400 shrink-0', className)} />
  }

  if (norm === 'mineracao' || norm === 'prospeccao' || norm === 'outreach') {
    return <Pickaxe size={size} className={cn('text-amber-500 dark:text-amber-400 shrink-0', className)} />
  }

  if (norm === 'whatsapp_official' || norm === 'meta') {
    return <MetaInfinityIcon size={size} className={cn('text-sky-500 dark:text-sky-400 shrink-0', className)} />
  }

  // Padrão: WhatsApp
  return <MessageCircle size={size} className={cn('text-emerald-500 dark:text-emerald-400 shrink-0', className)} />
}

export function ChannelBadge({
  channel,
  className,
}: {
  channel: ChannelType | null | undefined
  className?: string
}) {
  const norm = (channel || 'whatsapp').toLowerCase()

  if (norm === 'instagram' || norm === 'instagram_direct') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border border-pink-500/20 bg-pink-500/10 text-pink-600 dark:text-pink-400',
          className
        )}
      >
        <InstagramLogoIcon size={11} className="shrink-0" />
        <span>Instagram Direct</span>
      </span>
    )
  }

  if (norm === 'email' || norm === 'e-mail' || norm === 'brevo') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border border-indigo-500/20 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
          className
        )}
      >
        <Mail size={11} className="shrink-0" />
        <span>E-mail</span>
      </span>
    )
  }

  if (norm === 'mineracao' || norm === 'prospeccao' || norm === 'outreach') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400',
          className
        )}
      >
        <Pickaxe size={11} className="shrink-0" />
        <span>Mineração</span>
      </span>
    )
  }

  if (norm === 'whatsapp_official' || norm === 'meta') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-400',
          className
        )}
      >
        <MetaInfinityIcon size={11} className="shrink-0" />
        <span>WhatsApp Oficial</span>
      </span>
    )
  }

  // Padrão WhatsApp
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        className
      )}
    >
      <MessageCircle size={11} className="shrink-0" />
      <span>WhatsApp</span>
    </span>
  )
}

export interface OriginItem {
  key: string
  label: string
  color: string
  icon?: React.ReactNode
}

export function parseOriginItem(raw: string | null | undefined): OriginItem | null {
  if (!raw) return null
  const norm = raw.toLowerCase().trim()
  if (!norm || norm === 'null' || norm === 'undefined') return null

  // 1. Mineração
  if (norm.includes('miner') || norm.includes('mining') || norm.includes('outreach') || norm.includes('prospeccao') || norm.includes('places')) {
    return {
      key: 'mineracao',
      label: 'Mineração',
      color: 'border-amber-500/30 bg-amber-500/10 text-amber-500 dark:text-amber-400',
      icon: <Pickaxe size={10} className="shrink-0 text-amber-400" />,
    }
  }

  // 2. Meta Ads
  if (norm.includes('meta') || norm.includes('facebook') || norm.includes('fb') || (norm.includes('ads') && !norm.includes('google'))) {
    const label = norm.includes('lucas') ? 'Meta Ads Dr. Lucas' : norm.includes('insta') ? 'Instagram Ads' : 'Meta Ads'
    return {
      key: 'meta_ads',
      label,
      color: 'border-blue-500/30 bg-blue-500/10 text-blue-500 dark:text-blue-400',
      icon: <MetaInfinityIcon size={10} className="shrink-0 text-blue-400" />,
    }
  }

  // 3. Instagram Direct / Orgânico
  if (norm.includes('instagram') || norm.includes('direct') || norm.includes('ig')) {
    return {
      key: 'instagram',
      label: 'Instagram',
      color: 'border-pink-500/30 bg-pink-500/10 text-pink-500 dark:text-pink-400',
      icon: <InstagramLogoIcon size={10} className="shrink-0 text-pink-400" />,
    }
  }

  // 4. WhatsApp
  if (norm.includes('whats') || norm.includes('zap') || norm.includes('wpp')) {
    return {
      key: 'whatsapp',
      label: norm.includes('reserva') ? 'WhatsApp Reserva' : 'WhatsApp',
      color: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500 dark:text-emerald-400',
      icon: <MessageCircle size={10} className="shrink-0 text-emerald-400" />,
    }
  }

  // 5. E-mail
  if (norm.includes('email') || norm.includes('mail') || norm.includes('brevo')) {
    return {
      key: 'email',
      label: 'E-mail',
      color: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-500 dark:text-indigo-400',
      icon: <Mail size={10} className="shrink-0 text-indigo-400" />,
    }
  }

  // 6. Checkouts
  if (norm === 'hotmart' || norm.includes('hotmart')) {
    return {
      key: 'hotmart',
      label: 'Hotmart',
      color: 'border-orange-500/30 bg-orange-500/10 text-orange-500 dark:text-orange-400',
    }
  }
  if (norm === 'kiwify' || norm.includes('kiwify')) {
    return {
      key: 'kiwify',
      label: 'Kiwify',
      color: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-500 dark:text-cyan-400',
    }
  }
  if (norm === 'greenn' || norm.includes('greenn')) {
    return {
      key: 'greenn',
      label: 'Greenn',
      color: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500 dark:text-emerald-400',
    }
  }
  if (norm === 'zouti' || norm.includes('zouti')) {
    return {
      key: 'zouti',
      label: 'Zouti',
      color: 'border-purple-500/30 bg-purple-500/10 text-purple-500 dark:text-purple-400',
    }
  }

  // 7. Event types / Produtos
  if (norm === 'consulta_medica' || norm.includes('consulta')) {
    return {
      key: 'consulta',
      label: 'Consulta Médica',
      color: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400',
    }
  }
  if (norm === 'reserva_restaurante' || norm.includes('reserva')) {
    return {
      key: 'reserva',
      label: 'Reserva Restaurante',
      color: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
    }
  }
  if (norm === 'boleto') {
    return { key: 'boleto', label: 'Boleto', color: 'border-amber-500/30 bg-amber-500/10 text-amber-400' }
  }
  if (norm === 'pix') {
    return { key: 'pix', label: 'Pix', color: 'border-teal-500/30 bg-teal-500/10 text-teal-400' }
  }
  if (norm === 'carrinho_abandonado' || norm === 'carrinho') {
    return { key: 'carrinho', label: 'Carrinho', color: 'border-rose-500/30 bg-rose-500/10 text-rose-400' }
  }
  if (norm === 'cartao_recusado' || norm === 'cartao') {
    return { key: 'cartao', label: 'Cartão', color: 'border-red-500/30 bg-red-500/10 text-red-400' }
  }
  if (norm === 'compra_aprovada' || norm === 'aprovada') {
    return { key: 'aprovada', label: 'Aprovada', color: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' }
  }

  // Genérico formatado
  const cleaned = raw.replace(/[_-]/g, ' ').trim()
  return {
    key: norm,
    label: cleaned.charAt(0).toUpperCase() + cleaned.slice(1),
    color: 'border-line-subtle bg-surface-raised text-fg-subtle',
  }
}

export function PlatformBadge({
  platform,
  eventType,
  trackingSource,
  origins,
  className,
}: {
  platform?: string | null | undefined
  eventType?: string | null | undefined
  trackingSource?: string | null | undefined
  origins?: string[] | null | undefined
  className?: string
}) {
  // Coleta todas as origens possíveis sem repetição
  const rawList: string[] = []
  if (origins && Array.isArray(origins)) {
    rawList.push(...origins)
  }
  if (trackingSource) rawList.push(trackingSource)
  if (platform) rawList.push(platform)
  if (eventType && !['whatsapp', 'chat', 'direct'].includes(eventType.toLowerCase())) {
    rawList.push(eventType)
  }

  const itemsMap = new Map<string, OriginItem>()
  for (const raw of rawList) {
    const parsed = parseOriginItem(raw)
    if (parsed && !itemsMap.has(parsed.key)) {
      itemsMap.set(parsed.key, parsed)
    }
  }

  const badges = Array.from(itemsMap.values())
  if (badges.length === 0) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-md border border-line-subtle bg-surface-raised text-fg-subtle uppercase tracking-wider',
          className
        )}
      >
        <span>SAC</span>
      </span>
    )
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {badges.map((b) => (
        <span
          key={b.key}
          className={cn(
            'inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-md border uppercase tracking-wider shrink-0 transition-colors',
            b.color
          )}
        >
          {b.icon}
          <span>{b.label}</span>
        </span>
      ))}
    </div>
  )
}

export function BotStatusPill({
  paused,
  compact = false,
  className,
}: {
  paused: boolean
  compact?: boolean
  className?: string
}) {
  if (paused) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 font-bold text-amber-600 dark:text-amber-400',
          compact ? 'px-1.5 py-0.2 text-[9px]' : 'px-2.5 py-1 text-[11px]',
          className
        )}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-amber-400 shrink-0" />
        <span>{compact ? 'Humano' : 'Bot Pausado (Humano)'}</span>
      </span>
    )
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 font-bold text-emerald-600 dark:text-emerald-400',
        compact ? 'px-1.5 py-0.2 text-[9px]' : 'px-2.5 py-1 text-[11px]',
        className
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 animate-pulse shrink-0" />
      <span>{compact ? 'Bot IA' : 'Bot IA Ativo'}</span>
    </span>
  )
}
