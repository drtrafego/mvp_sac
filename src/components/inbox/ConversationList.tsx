'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Search,
  RefreshCw,
  MessageSquare,
  Filter,
  X,
  Bot,
  UserCog,
  MessageCircle,
  Mail,
  Pickaxe,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  ChannelIcon,
  ChannelBadge,
  PlatformBadge,
  BotStatusPill,
  InstagramLogoIcon,
} from './ChannelBadge'
import { MetaWindowBadge } from './MetaWindowBadge'

export interface ConversationSummary {
  id: number
  phone: string
  name: string | null
  email?: string | null
  eventType: string
  status: string | null
  productName: string | null
  productValue?: number | null
  platform?: string | null
  channel?: string | null
  botPaused?: boolean
  botPausedAt?: string | null
  botPausedBy?: string | null
  trackingSource?: string | null
  utmCampaign?: string | null
  lastMessage: string | null
  lastDirection: string | null
  lastMessageAt: string | null
  lastInboundAt?: string | null
  lastOutboundAt?: string | null
  unread: number
}

function formatMessageTimestamp(dateStr: string | null | undefined): { time: string; full: string; relative: string } {
  if (!dateStr) return { time: '', full: '', relative: '' }
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return { time: '', full: '', relative: '' }

  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const isYesterday = d.toDateString() === yesterday.toDateString()

  const hours = String(d.getHours()).padStart(2, '0')
  const mins = String(d.getMinutes()).padStart(2, '0')
  const timeOnly = `${hours}:${mins}`

  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60_000)
  let relative = 'agora'
  if (diffMins >= 1 && diffMins < 60) relative = `${diffMins}m`
  else if (diffMins >= 60 && diffMins < 1440) relative = `${Math.floor(diffMins / 60)}h`
  else if (diffMins >= 1440) relative = `${Math.floor(diffMins / 1440)}d`

  let display = ''
  if (isToday) {
    display = timeOnly
  } else if (isYesterday) {
    display = `ontem ${timeOnly}`
  } else if (diffMs < 7 * 24 * 3600 * 1000) {
    const days = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
    display = `${days[d.getDay()]} ${timeOnly}`
  } else {
    display = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${timeOnly}`
  }

  return {
    time: display,
    full: d.toLocaleString('pt-BR'),
    relative,
  }
}

type ChannelFilter = 'all' | 'whatsapp' | 'instagram' | 'email' | 'mineracao'
type StatusFilter = 'all' | 'paused' | 'active' | 'unread'

export function ConversationList({ initial }: { initial: ConversationSummary[] }) {
  const [convs, setConvs] = useState<ConversationSummary[]>(initial)
  const [search, setSearch] = useState('')
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [refreshing, setRefreshing] = useState(false)
  const pathname = usePathname()

  const refresh = useCallback(async (silent = true) => {
    if (!silent) setRefreshing(true)
    try {
      const res = await fetch('/api/inbox')
      if (res.ok) {
        const data = await res.json()
        setConvs(data)
      }
    } catch {
      /* silencioso */
    } finally {
      if (!silent) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    const t = setInterval(() => refresh(true), 15_000)
    return () => clearInterval(t)
  }, [refresh])

  const activeId = pathname.split('/inbox/')[1]?.split('/')[0] || ''

  const filtered = useMemo(() => {
    return convs.filter(c => {
      // 1. Filtro por canal
      if (channelFilter !== 'all') {
        const ch = (c.channel || 'whatsapp').toLowerCase()
        const pl = (c.platform || '').toLowerCase()
        const src = (c.trackingSource || '').toLowerCase()
        if (channelFilter === 'instagram') {
          if (ch !== 'instagram' && pl !== 'instagram' && !src.includes('instagram') && !c.phone.startsWith('ig_')) {
            return false
          }
        } else if (channelFilter === 'email') {
          if (ch !== 'email' && !src.includes('email') && !src.includes('brevo')) {
            return false
          }
        } else if (channelFilter === 'mineracao') {
          if (ch !== 'mineracao' && pl !== 'mineracao' && !src.includes('mineracao') && !src.includes('prospeccao')) {
            return false
          }
        } else if (channelFilter === 'whatsapp') {
          if (ch !== 'whatsapp' || c.phone.startsWith('ig_')) {
            return false
          }
        }
      }

      // 2. Filtro por status do bot / leitura
      if (statusFilter === 'paused' && !c.botPaused) return false
      if (statusFilter === 'active' && c.botPaused) return false
      if (statusFilter === 'unread' && (!c.unread || c.unread === 0)) return false

      // 3. Busca por texto
      if (!search.trim()) return true
      const q = search.trim().toLowerCase()
      return (
        c.name?.toLowerCase().includes(q) ||
        c.phone.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q) ||
        c.productName?.toLowerCase().includes(q) ||
        c.lastMessage?.toLowerCase().includes(q)
      )
    })
  }, [convs, channelFilter, statusFilter, search])

  const channelCounts = useMemo(() => {
    const counts = { all: convs.length, whatsapp: 0, instagram: 0, email: 0, mineracao: 0 }
    convs.forEach(c => {
      const ch = (c.channel || 'whatsapp').toLowerCase()
      const pl = (c.platform || '').toLowerCase()
      const src = (c.trackingSource || '').toLowerCase()
      if (ch === 'instagram' || pl === 'instagram' || src.includes('instagram') || c.phone.startsWith('ig_')) {
        counts.instagram++
      } else if (ch === 'email' || src.includes('email') || src.includes('brevo')) {
        counts.email++
      } else if (ch === 'mineracao' || pl === 'mineracao' || src.includes('mineracao') || src.includes('prospeccao')) {
        counts.mineracao++
      } else {
        counts.whatsapp++
      }
    })
    return counts
  }, [convs])

  return (
    <aside
      className={cn(
        'w-full shrink-0 md:w-[330px] xl:w-[380px] flex-col border-r border-line-subtle bg-surface-panel',
        activeId ? 'hidden md:flex' : 'flex'
      )}
    >
      {/* Cabeçalho com Título, Total e Refresh */}
      <div className="border-b border-line-subtle p-3.5 space-y-2.5 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-h3 text-fg font-bold">Conversas</h2>
            <span className="text-micro font-mono bg-surface-raised border border-line-subtle px-1.5 py-0.5 rounded-full text-fg-subtle">
              {filtered.length}
            </span>
          </div>
          <button
            onClick={() => refresh(false)}
            disabled={refreshing}
            title="Atualizar conversas"
            aria-label="Atualizar conversas"
            className="focus-ring h-8 w-8 flex items-center justify-center rounded-lg text-fg-subtle transition-colors hover:text-fg hover:bg-surface-inset disabled:opacity-40 cursor-pointer"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* Campo de Busca */}
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar por nome, contato, mensagem..."
            className="focus-ring h-9 w-full rounded-xl border border-line-subtle bg-surface-inset pl-9 pr-8 text-micro text-fg placeholder:text-fg-subtle outline-none"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg p-0.5"
            >
              <X size={13} />
            </button>
          )}
        </div>

        {/* Abas Rápidas de Canal */}
        <div className="flex items-center gap-1 overflow-x-auto scroll-thin pb-0.5 pt-0.5">
          <button
            type="button"
            onClick={() => setChannelFilter('all')}
            className={cn(
              'px-2.5 py-1 rounded-lg text-[11px] font-bold tracking-tight shrink-0 transition-colors cursor-pointer',
              channelFilter === 'all'
                ? 'bg-brand-solid text-on-accent shadow-xs'
                : 'bg-surface-inset text-fg-subtle hover:text-fg hover:bg-surface-raised'
            )}
          >
            Todos ({channelCounts.all})
          </button>
          <button
            type="button"
            onClick={() => setChannelFilter('whatsapp')}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold tracking-tight shrink-0 transition-colors cursor-pointer',
              channelFilter === 'whatsapp'
                ? 'bg-emerald-500 text-white shadow-xs'
                : 'bg-surface-inset text-fg-subtle hover:text-fg hover:bg-surface-raised'
            )}
          >
            <MessageCircle size={12} className="text-emerald-400 shrink-0" />
            WhatsApp ({channelCounts.whatsapp})
          </button>
          <button
            type="button"
            onClick={() => setChannelFilter('instagram')}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold tracking-tight shrink-0 transition-colors cursor-pointer',
              channelFilter === 'instagram'
                ? 'bg-pink-600 text-white shadow-xs'
                : 'bg-surface-inset text-fg-subtle hover:text-fg hover:bg-surface-raised'
            )}
          >
            <InstagramLogoIcon size={12} className="text-pink-400 shrink-0" />
            Direct ({channelCounts.instagram})
          </button>
          <button
            type="button"
            onClick={() => setChannelFilter('email')}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold tracking-tight shrink-0 transition-colors cursor-pointer',
              channelFilter === 'email'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'bg-surface-inset text-fg-subtle hover:text-fg hover:bg-surface-raised'
            )}
          >
            <Mail size={12} className="text-indigo-400 shrink-0" />
            E-mail ({channelCounts.email})
          </button>
          <button
            type="button"
            onClick={() => setChannelFilter('mineracao')}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold tracking-tight shrink-0 transition-colors cursor-pointer',
              channelFilter === 'mineracao'
                ? 'bg-amber-600 text-white shadow-xs'
                : 'bg-surface-inset text-fg-subtle hover:text-fg hover:bg-surface-raised'
            )}
          >
            <Pickaxe size={12} className="text-amber-400 shrink-0" />
            Mineração ({channelCounts.mineracao})
          </button>
        </div>

        {/* Filtro secundário: Status do Atendimento / Bot */}
        <div className="flex items-center justify-between text-[11px] pt-1">
          <span className="text-fg-faint font-semibold uppercase text-[10px] tracking-wider">Status:</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setStatusFilter('all')}
              className={cn(
                'px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors cursor-pointer',
                statusFilter === 'all' ? 'text-fg font-bold underline decoration-brand-ink' : 'text-fg-subtle hover:text-fg'
              )}
            >
              Todos
            </button>
            <span className="text-fg-faint">·</span>
            <button
              onClick={() => setStatusFilter('paused')}
              className={cn(
                'px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors cursor-pointer flex items-center gap-0.5',
                statusFilter === 'paused' ? 'text-amber-500 font-bold underline' : 'text-fg-subtle hover:text-amber-500'
              )}
            >
              <UserCog size={10} /> Pausados
            </button>
            <span className="text-fg-faint">·</span>
            <button
              onClick={() => setStatusFilter('active')}
              className={cn(
                'px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors cursor-pointer flex items-center gap-0.5',
                statusFilter === 'active' ? 'text-emerald-500 font-bold underline' : 'text-fg-subtle hover:text-emerald-500'
              )}
            >
              <Bot size={10} /> Bot Ativo
            </button>
            <span className="text-fg-faint">·</span>
            <button
              onClick={() => setStatusFilter('unread')}
              className={cn(
                'px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors cursor-pointer',
                statusFilter === 'unread' ? 'text-brand-ink font-bold underline' : 'text-fg-subtle hover:text-fg'
              )}
            >
              Não lidos
            </button>
          </div>
        </div>
      </div>

      {/* Lista de Conversas com Scroll */}
      <div className="scroll-thin flex-1 overflow-y-auto p-2 space-y-1 pb-[calc(4rem+env(safe-area-inset-bottom))] lg:pb-2">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-fg-faint text-center px-4">
            <MessageSquare size={28} className="opacity-40" />
            <p className="text-body font-semibold text-fg-muted">Nenhuma conversa encontrada</p>
            <p className="text-micro text-fg-subtle">
              {search || channelFilter !== 'all' || statusFilter !== 'all'
                ? 'Tente ajustar os filtros ou termo de busca acima.'
                : 'Novos leads e mensagens recebidas aparecerão aqui em tempo real.'}
            </p>
          </div>
        ) : (
          filtered.map(conv => {
            const isActive = String(conv.id) === activeId
            const displayName = conv.name || conv.phone
            const initials = displayName.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase()
            const timeInfo = formatMessageTimestamp(conv.lastMessageAt)

            return (
              <Link key={conv.id} href={`/inbox/${conv.id}`} className="focus-ring block rounded-xl">
                <div
                  className={cn(
                    'relative flex flex-col gap-1.5 rounded-xl p-2.5 transition-all cursor-pointer border',
                    isActive
                      ? 'bg-surface-raised border-brand-solid/40 shadow-xs'
                      : 'border-transparent hover:border-line-subtle hover:bg-surface-inset/70'
                  )}
                >
                  {/* Linha 1: Nome, Hora do Último Envio e Ícone do Canal */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-inset border border-line-subtle text-[11px] font-bold text-fg-muted">
                        {initials}
                      </div>
                      <span className="truncate text-body font-semibold text-fg leading-tight">
                        {displayName}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <ChannelIcon channel={conv.channel} size={13} />
                      {timeInfo.time ? (
                        <span className="text-[11px] text-fg-subtle font-mono font-medium" title={timeInfo.full}>
                          {timeInfo.time}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  {/* Linha 2: Badges de Origem, Janela Meta (24h/72h) e Status do Bot */}
                  <div className="flex flex-wrap items-center gap-1">
                    <PlatformBadge platform={conv.platform || conv.trackingSource} eventType={conv.eventType} />
                    <MetaWindowBadge lead={conv} />
                    {conv.botPaused && (
                      <BotStatusPill paused={true} compact />
                    )}
                    {conv.unread > 0 && (
                      <span className="ml-auto inline-flex items-center justify-center bg-brand-solid text-on-accent text-[10px] font-bold h-4 min-w-4 px-1 rounded-full">
                        {conv.unread}
                      </span>
                    )}
                  </div>

                  {/* Linha 3: Prévia da última mensagem e tempo relativo */}
                  <div className="text-micro text-fg-subtle truncate flex items-center justify-between gap-2">
                    <div className="truncate flex items-center gap-1 min-w-0">
                      {conv.lastDirection === 'outbound' && (
                        <span className="text-fg-faint shrink-0 font-semibold">Você:</span>
                      )}
                      <span className="truncate">{conv.lastMessage || 'Conversa iniciada'}</span>
                    </div>
                    {timeInfo.relative && timeInfo.relative !== 'agora' && (
                      <span className="text-[10px] text-fg-faint shrink-0 font-mono">
                        {timeInfo.relative}
                      </span>
                    )}
                  </div>
                </div>
              </Link>
            )
          })
        )}
      </div>
    </aside>
  )
}
