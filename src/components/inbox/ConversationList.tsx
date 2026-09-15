'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Search, RefreshCw, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ConversationSummary {
  id: number
  phone: string
  name: string | null
  eventType: string
  status: string | null
  productName: string | null
  lastMessage: string | null
  lastDirection: string | null
  lastMessageAt: string | null
  unread: number
}

const eventLabels: Record<string, string> = {
  boleto: 'Boleto',
  pix: 'Pix',
  carrinho_abandonado: 'Carrinho',
  cartao_recusado: 'Cartão',
  compra_aprovada: 'Compra',
}

/* O tipo de evento aparece só como ponto colorido, com o rótulo no title */
const eventDot: Record<string, string> = {
  boleto: 'text-ev-boleto',
  pix: 'text-ev-pix',
  carrinho_abandonado: 'text-ev-carrinho',
  cartao_recusado: 'text-ev-cartao',
  compra_aprovada: 'text-ev-aprovada',
}

function timeAgo(dateStr: string | null) {
  if (!dateStr) return ''
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'agora'
  if (mins < 60) return `${mins}min`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

export function ConversationList({ initial }: { initial: ConversationSummary[] }) {
  const [convs, setConvs] = useState(initial)
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const pathname = usePathname()

  const refresh = useCallback(async (silent = true) => {
    if (!silent) setRefreshing(true)
    try {
      const res = await fetch('/api/inbox')
      if (res.ok) setConvs(await res.json())
    } catch { /* silencioso */ }
    finally { if (!silent) setRefreshing(false) }
  }, [])

  useEffect(() => {
    const t = setInterval(() => refresh(true), 30_000)
    return () => clearInterval(t)
  }, [refresh])

  const activeId = pathname.split('/inbox/')[1]?.split('/')[0] || ''

  const filtered = convs.filter(c => {
    if (!search) return true
    const q = search.toLowerCase()
    return c.name?.toLowerCase().includes(q) || c.phone.includes(q) || c.lastMessage?.toLowerCase().includes(q)
  })

  return (
    <aside
      className={cn(
        'w-full shrink-0 md:w-[320px] xl:w-[360px] flex-col border-r border-line-subtle bg-surface-panel',
        // No mobile a lista some quando uma conversa está aberta
        activeId ? 'hidden md:flex' : 'flex'
      )}
    >
      <div className="border-b border-line-subtle px-4 py-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-h3 text-fg">Conversas</h2>
          <button
            onClick={() => refresh(false)}
            disabled={refreshing}
            aria-label="Atualizar conversas"
            className="focus-ring h-11 w-11 lg:h-7 lg:w-7 -mr-2 lg:mr-0 flex items-center justify-center rounded-[var(--r-sm)] text-fg-subtle transition-colors hover:text-fg hover:bg-surface-inset disabled:opacity-40 cursor-pointer"
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
        {/* text-base no mobile evita o zoom automático do iOS ao focar */}
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar..."
            aria-label="Buscar conversas"
            className="focus-ring h-[var(--control-lg)] lg:h-[var(--control-md)] w-full rounded-[var(--r-md)] border border-line-subtle bg-surface-inset pl-9 pr-3 text-base lg:text-body text-fg placeholder:text-fg-subtle outline-none"
          />
        </div>
      </div>

      {/* pb extra para a última conversa não ficar sob a tab bar do mobile */}
      <div className="scroll-thin flex-1 overflow-y-auto p-2 pb-[calc(4rem+env(safe-area-inset-bottom))] lg:pb-2">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-fg-faint">
            <MessageSquare size={24} />
            <p className="text-micro">{search ? 'Nenhuma conversa encontrada' : 'Nenhum lead ainda'}</p>
          </div>
        ) : (
          filtered.map(conv => {
            const isActive = String(conv.id) === activeId
            const displayName = conv.name || conv.phone
            const initials = displayName.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase()
            const eventLabel = eventLabels[conv.eventType] ?? conv.eventType

            return (
              <Link key={conv.id} href={`/inbox/${conv.id}`} className="focus-ring block rounded-[var(--r-md)]">
                <div className={cn(
                  'relative flex h-[72px] items-center gap-3 rounded-[var(--r-md)] px-3 transition-colors cursor-pointer',
                  isActive ? 'bg-surface-inset' : 'hover:bg-surface-inset'
                )}>
                  {isActive && (
                    <span className="absolute left-0 top-1/2 h-8 w-[3px] -translate-y-1/2 rounded-full bg-brand-ink" />
                  )}
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-inset text-micro font-semibold text-fg-muted">
                    {initials}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className={cn('dot', eventDot[conv.eventType] ?? 'text-fg-faint')}
                          title={eventLabel}
                        />
                        <span className="truncate text-h3 text-fg">{displayName}</span>
                      </span>
                      <span className="num shrink-0 text-micro text-fg-faint">{timeAgo(conv.lastMessageAt)}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="truncate text-micro text-fg-subtle">
                        {conv.lastDirection === 'outbound' ? 'Você: ' : ''}
                        {conv.lastMessage || eventLabel}
                      </span>
                      {conv.unread > 0 && (
                        <span className="num flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand-solid px-1.5 text-micro font-semibold text-on-accent">
                          {conv.unread > 9 ? '9+' : conv.unread}
                        </span>
                      )}
                    </div>
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
