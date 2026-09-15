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

export function PlatformBadge({
  platform,
  eventType,
  className,
}: {
  platform: string | null | undefined
  eventType?: string | null | undefined
  className?: string
}) {
  const norm = (platform || '').toLowerCase()

  const eventLabelMap: Record<string, string> = {
    boleto: 'Boleto',
    pix: 'Pix',
    carrinho_abandonado: 'Carrinho',
    cartao_recusado: 'Cartão',
    compra_aprovada: 'Aprovada',
    instagram_direct: 'Direct',
  }

  const evLabel = eventType ? eventLabelMap[eventType] || eventType : null

  let badgeColor = 'border-line-subtle bg-surface-raised text-fg-subtle'
  let label = norm || 'SAC'

  if (norm === 'hotmart') {
    badgeColor = 'border-orange-500/20 bg-orange-500/10 text-orange-600 dark:text-orange-400'
    label = 'Hotmart'
  } else if (norm === 'kiwify') {
    badgeColor = 'border-cyan-500/20 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400'
    label = 'Kiwify'
  } else if (norm === 'greenn') {
    badgeColor = 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
    label = 'Greenn'
  } else if (norm === 'zouti') {
    badgeColor = 'border-purple-500/20 bg-purple-500/10 text-purple-600 dark:text-purple-400'
    label = 'Zouti'
  } else if (norm === 'instagram') {
    badgeColor = 'border-pink-500/20 bg-pink-500/10 text-pink-600 dark:text-pink-400'
    label = 'Instagram'
  } else if (norm === 'mineracao' || norm === 'prospeccao') {
    badgeColor = 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400'
    label = 'Mineração'
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-md border uppercase tracking-wider',
        badgeColor,
        className
      )}
    >
      <span>{label}</span>
      {evLabel && <span className="opacity-75 font-normal">· {evLabel}</span>}
    </span>
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
