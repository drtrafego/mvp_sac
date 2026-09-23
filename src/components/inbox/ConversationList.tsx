'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
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
  Megaphone,
  AlertCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  ChannelIcon,
  ChannelBadge,
  PlatformBadge,
  BotStatusPill,
  InstagramLogoIcon,
  MetaInfinityIcon,
  EmailEngagementBadge,
} from './ChannelBadge'
import type { EmailEngagement } from '@/lib/email-engagement'
import { MetaWindowBadge } from './MetaWindowBadge'
import {
  classifyAnuncioSubcategory,
  classifyChannelInMemory,
  classifyMineracaoSubchannel,
  matchesPhoneSearch,
} from '@/lib/inbox-channel-filter'
import { matchesInboxSourceFilter } from '@/lib/inbox-source-filter'

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
  allOrigins?: string[]
  allEventTypes?: string[]
  lastMessage: string | null
  lastDirection: string | null
  lastMessageAt: string | null
  lastInboundAt?: string | null
  lastOutboundAt?: string | null
  createdAt?: string | null
  unread: number
  emailEngagement?: EmailEngagement | null
}

function formatMessageTimestamp(dateStr: string | null | undefined): { time: string; full: string; relative: string } {
  if (!dateStr) return { time: '', full: '', relative: '' }
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return { time: '', full: '', relative: '' }

  const timeOnly = d.toLocaleTimeString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
  })

  const dateBR = d.toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
  })

  const now = new Date()
  const todayBR = now.toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
  })

  const yesterday = new Date(now.getTime() - 86_400_000)
  const yesterdayBR = yesterday.toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
  })

  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60_000)
  let relative = 'agora'
  if (diffMins >= 1 && diffMins < 60) relative = `${diffMins}m`
  else if (diffMins >= 60 && diffMins < 1440) relative = `${Math.floor(diffMins / 60)}h`
  else if (diffMins >= 1440) relative = `${Math.floor(diffMins / 1440)}d`

  let display = ''
  if (dateBR === todayBR) {
    display = timeOnly
  } else if (dateBR === yesterdayBR) {
    display = `ontem ${timeOnly}`
  } else {
    display = `${dateBR} ${timeOnly}`
  }

  return {
    time: display,
    full: `${dateBR} às ${timeOnly}`,
    relative,
  }
}

type ChannelFilter = 'all' | 'whatsapp' | 'instagram' | 'email' | 'mineracao' | 'anuncio'
type StatusFilter = 'all' | 'paused' | 'active' | 'unread'
// Sub-filtro de canal REAL de contato, só relevante quando channelFilter é
// 'mineracao': 'all' mostra tudo dentro de mineração (comportamento de
// sempre), os outros três restringem ao sub-canal. Aparece como um segundo
// nível de aba (mesmo padrão visual já usado no filtro de Status abaixo),
// não como abas novas na fileira principal.
type MineracaoSubFilter = 'all' | 'email' | 'whatsapp' | 'instagram'
type AnuncioSubFilter = 'all' | 'meta_ads' | 'google_ads'

// classifyChannel é só um adaptador fino pra classifyChannelInMemory
// (src/lib/inbox-channel-filter.ts), que é a ÚNICA fonte da verdade da
// heurística de canal, compartilhada com o WHERE do banco
// (channelWhereCondition). Não reimplementar a lógica aqui: SQL e memória
// não têm mais como divergir porque leem a mesma lista de regras.
function classifyChannel(c: Pick<ConversationSummary, 'channel' | 'platform' | 'trackingSource' | 'phone'>) {
  return classifyChannelInMemory(c)
}

export function ConversationList({ initial, initialError = null }: { initial: ConversationSummary[]; initialError?: string | null }) {
  const [convs, setConvs] = useState<ConversationSummary[]>(initial)
  const [error, setError] = useState<string | null>(initialError)
  const [search, setSearch] = useState('')
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all')
  const [mineracaoSubFilter, setMineracaoSubFilter] = useState<MineracaoSubFilter>('all')
  const [anuncioSubFilter, setAnuncioSubFilter] = useState<AnuncioSubFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [refreshing, setRefreshing] = useState(false)
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const sourceFilter = searchParams.get('source')?.trim() || ''

  // Busca no backend já filtrada pelo canal selecionado: a aba "Todos" não
  // manda parâmetro (mesmo comportamento de sempre), as abas de canal
  // específico mandam ?channel=X, reaproveitando o chFilter que o backend já
  // sabia interpretar mas que o front nunca enviava. Sem isso, a lista corta
  // em 200 registros misturando todos os canais antes de filtrar, e um canal
  // de baixo volume por conversa (e-mail) pode nunca aparecer.
  // Canal composto pra mandar ao backend: 'mineracao' + sub-filtro vira
  // 'mineracao_email'/'mineracao_whatsapp'/'mineracao_instagram', que
  // channelWhereCondition (src/lib/inbox-channel-filter.ts) já sabe
  // interpretar como "mineracao E, dentro dela, este canal real".
  // 'anuncio' segue o mesmo padrão com 'anuncio_meta_ads'/'anuncio_google_ads'.
  const effectiveChannelParam =
    channelFilter === 'mineracao' && mineracaoSubFilter !== 'all'
      ? `mineracao_${mineracaoSubFilter}`
      : channelFilter === 'anuncio' && anuncioSubFilter !== 'all'
      ? `anuncio_${anuncioSubFilter}`
      : channelFilter

  const refresh = useCallback(
    async (silent = true) => {
      if (!silent) setRefreshing(true)
      try {
        const params = new URLSearchParams()
        if (effectiveChannelParam !== 'all') params.set('channel', effectiveChannelParam)
        if (sourceFilter) params.set('source', sourceFilter)
        const qs = params.toString()
        const res = await fetch(`/api/inbox${qs ? `?${qs}` : ''}`)
        if (res.ok) {
          const data = await res.json()
          setConvs(data)
          setError(null)
        } else {
          setError('Erro ao sincronizar conversas com o servidor.')
        }
      } catch {
        setError('Falha de rede ao buscar conversas.')
      } finally {
        if (!silent) setRefreshing(false)
      }
    },
    [effectiveChannelParam, sourceFilter]
  )

  // Refetch imediato ao trocar de aba (não espera o poll de 15s). O
  // carregamento inicial já veio do Server Component com "Todos", então pula
  // a primeira execução pra não duplicar aquela mesma busca.
  const didMountRef = useRef(false)
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      if (!sourceFilter) return
    }
    refresh(true)
  }, [refresh, sourceFilter])

  useEffect(() => {
    const t = setInterval(() => refresh(true), 15_000)
    return () => clearInterval(t)
  }, [refresh])

  // Contagem por aba: vem de /api/inbox/counts (COUNT real no banco, empresa
  // inteira). O cálculo local abaixo é só o palpite inicial antes do fetch
  // responder (evita "0" piscando na primeira renderização); depois disso
  // quem manda é sempre a resposta do endpoint, nunca o array já cortado em
  // 200 e filtrado por canal, que mostraria só o total daquele canal e
  // zeraria os outros.
  const [counts, setCounts] = useState(() => {
    const initialCounts = {
      all: initial.length,
      whatsapp: 0,
      instagram: 0,
      email: 0,
      mineracao: 0,
      mineracaoEmail: 0,
      mineracaoWhatsapp: 0,
      mineracaoInstagram: 0,
      anuncio: 0,
      anuncioMetaAds: 0,
      anuncioGoogleAds: 0,
    }
    initial.forEach(c => {
      const { isInstagram, isEmail, isMineracao, isAnuncio, isWhatsapp } = classifyChannel(c)
      if (isInstagram) initialCounts.instagram++
      else if (isEmail) initialCounts.email++
      else if (isMineracao) {
        initialCounts.mineracao++
        const sub = classifyMineracaoSubchannel(c)
        if (sub === 'email') initialCounts.mineracaoEmail++
        else if (sub === 'instagram') initialCounts.mineracaoInstagram++
        else initialCounts.mineracaoWhatsapp++
      } else if (isAnuncio) {
        initialCounts.anuncio++
        const sub = classifyAnuncioSubcategory(c)
        if (sub === 'google_ads') initialCounts.anuncioGoogleAds++
        else initialCounts.anuncioMetaAds++
      } else if (isWhatsapp) initialCounts.whatsapp++
    })
    return initialCounts
  })

  const fetchCounts = useCallback(async () => {
    try {
      const qs = sourceFilter ? `?source=${encodeURIComponent(sourceFilter)}` : ''
      const res = await fetch(`/api/inbox/counts${qs}`)
      if (res.ok) {
        const data = await res.json()
        setCounts(data)
      }
    } catch {
      // mantém a última contagem conhecida (calculada localmente na primeira carga)
    }
  }, [sourceFilter])

  useEffect(() => {
    fetchCounts() // eslint-disable-line react-hooks/set-state-in-effect -- fetch assíncrono, setState só corre depois do await, não durante o corpo do effect
    const t = setInterval(fetchCounts, 15_000)
    return () => clearInterval(t)
  }, [fetchCounts])

  // Troca de aba principal: sair de "Mineração" limpa o sub-filtro de canal
  // real (senão o usuário voltaria pra "WhatsApp", por exemplo, com um
  // sub-filtro fantasma que não se aplica mais a nenhuma aba visível).
  const selectChannelFilter = useCallback((next: ChannelFilter) => {
    setChannelFilter(next)
    if (next !== 'mineracao') setMineracaoSubFilter('all')
    if (next !== 'anuncio') setAnuncioSubFilter('all')
  }, [])

  const clearSourceFilter = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString())
    params.delete('source')
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [pathname, router, searchParams])

  const activeId = pathname.split('/inbox/')[1]?.split('/')[0] || ''

  const filtered = useMemo(() => {
    return convs.filter(c => {
      // 0. Filtro por origem recebido via /inbox?source=...
      if (!matchesInboxSourceFilter(c, sourceFilter)) return false

      // 1. Filtro por canal
      if (channelFilter !== 'all') {
        const { isInstagram, isEmail, isMineracao, isAnuncio, isWhatsapp } = classifyChannel(c)
        if (channelFilter === 'instagram' && !isInstagram) return false
        if (channelFilter === 'email' && !isEmail) return false
        if (channelFilter === 'mineracao') {
          if (!isMineracao) return false
          // 1b. Dentro de mineração, sub-filtro pelo canal REAL de contato.
          if (mineracaoSubFilter !== 'all' && classifyMineracaoSubchannel(c) !== mineracaoSubFilter) return false
        }
        if (channelFilter === 'anuncio') {
          if (!isAnuncio) return false
          if (anuncioSubFilter !== 'all' && classifyAnuncioSubcategory(c) !== anuncioSubFilter) return false
        }
        if (channelFilter === 'whatsapp' && !isWhatsapp) return false
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
        matchesPhoneSearch(c.phone, q) ||
        c.email?.toLowerCase().includes(q) ||
        c.productName?.toLowerCase().includes(q) ||
        c.lastMessage?.toLowerCase().includes(q)
      )
    })
  }, [convs, sourceFilter, channelFilter, mineracaoSubFilter, anuncioSubFilter, statusFilter, search])

  return (
    <aside
      className={cn(
        'w-full shrink-0 md:w-[330px] xl:w-[380px] flex flex-col border-r border-line-subtle bg-surface-panel h-full min-h-0 overflow-hidden',
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
        <div className="relative">
          <div className="flex items-center gap-1 overflow-x-auto scroll-thin pb-0.5 pt-0.5">
          <button
            type="button"
            onClick={() => selectChannelFilter('all')}
            className={cn(
              'px-2.5 py-1 rounded-lg text-[11px] font-bold tracking-tight shrink-0 transition-colors cursor-pointer',
              channelFilter === 'all'
                ? 'bg-brand-solid text-on-accent shadow-xs'
                : 'bg-surface-inset text-fg-subtle hover:text-fg hover:bg-surface-raised'
            )}
          >
            Todos ({counts.all})
          </button>
          <button
            type="button"
            onClick={() => selectChannelFilter('whatsapp')}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold tracking-tight shrink-0 transition-colors cursor-pointer',
              channelFilter === 'whatsapp'
                ? 'bg-emerald-500 text-white shadow-xs'
                : 'bg-surface-inset text-fg-subtle hover:text-fg hover:bg-surface-raised'
            )}
          >
            <MessageCircle size={12} className="text-emerald-400 shrink-0" />
            WhatsApp ({counts.whatsapp})
          </button>
          <button
            type="button"
            onClick={() => selectChannelFilter('instagram')}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold tracking-tight shrink-0 transition-colors cursor-pointer',
              channelFilter === 'instagram'
                ? 'bg-pink-600 text-white shadow-xs'
                : 'bg-surface-inset text-fg-subtle hover:text-fg hover:bg-surface-raised'
            )}
          >
            <InstagramLogoIcon size={12} className="text-pink-400 shrink-0" />
            Direct ({counts.instagram})
          </button>
          <button
            type="button"
            onClick={() => selectChannelFilter('email')}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold tracking-tight shrink-0 transition-colors cursor-pointer',
              channelFilter === 'email'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'bg-surface-inset text-fg-subtle hover:text-fg hover:bg-surface-raised'
            )}
          >
            <Mail size={12} className="text-indigo-400 shrink-0" />
            E-mail ({counts.email})
          </button>
          <button
            type="button"
            onClick={() => selectChannelFilter('mineracao')}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold tracking-tight shrink-0 transition-colors cursor-pointer',
              channelFilter === 'mineracao'
                ? 'bg-amber-600 text-white shadow-xs'
                : 'bg-surface-inset text-fg-subtle hover:text-fg hover:bg-surface-raised'
            )}
          >
            <Pickaxe size={12} className="text-amber-400 shrink-0" />
            Mineração ({counts.mineracao})
          </button>
          <button
            type="button"
            onClick={() => selectChannelFilter('anuncio')}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold tracking-tight shrink-0 transition-colors cursor-pointer',
              channelFilter === 'anuncio'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'bg-surface-inset text-fg-subtle hover:text-fg hover:bg-surface-raised'
            )}
          >
            <Megaphone size={12} className="text-blue-400 shrink-0" />
            Anúncio ({counts.anuncio})
          </button>
          </div>
          <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface-panel to-transparent" />
        </div>

        {sourceFilter && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-brand-solid/20 bg-brand-glow px-2.5 py-1.5 text-[11px]">
            <span className="min-w-0 truncate font-semibold text-brand-ink" title={sourceFilter}>
              Origem: {sourceFilter}
            </span>
            <button
              type="button"
              onClick={clearSourceFilter}
              className="focus-ring flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-brand-ink/80 transition-colors hover:bg-surface-inset hover:text-fg cursor-pointer"
              aria-label="Limpar filtro de origem"
              title="Limpar filtro de origem"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {/* Sub-filtro: canal REAL de contato dentro de Mineração. Só aparece
            com a aba Mineração ativa, mesmo padrão visual do filtro de Status
            logo abaixo (label maiúscula + pills sublinhadas). "IG" só entra
            se o dado real trouxer volume (counts.mineracaoInstagram > 0),
            pra não oferecer um filtro que nunca teria resultado. */}
        {channelFilter === 'mineracao' && (
          <div className="flex items-center justify-between text-[11px] pt-1">
            <span className="text-fg-faint font-semibold uppercase text-[10px] tracking-wider">Canal real:</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setMineracaoSubFilter('all')}
                className={cn(
                  'px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors cursor-pointer',
                  mineracaoSubFilter === 'all' ? 'text-fg font-bold underline decoration-brand-ink' : 'text-fg-subtle hover:text-fg'
                )}
              >
                Todos
              </button>
              <span className="text-fg-faint">·</span>
              <button
                type="button"
                onClick={() => setMineracaoSubFilter('whatsapp')}
                className={cn(
                  'px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors cursor-pointer flex items-center gap-0.5',
                  mineracaoSubFilter === 'whatsapp' ? 'text-emerald-500 font-bold underline' : 'text-fg-subtle hover:text-emerald-500'
                )}
              >
                <MessageCircle size={10} /> WhatsApp ({counts.mineracaoWhatsapp})
              </button>
              <span className="text-fg-faint">·</span>
              <button
                type="button"
                onClick={() => setMineracaoSubFilter('email')}
                className={cn(
                  'px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors cursor-pointer flex items-center gap-0.5',
                  mineracaoSubFilter === 'email' ? 'text-indigo-500 font-bold underline' : 'text-fg-subtle hover:text-indigo-500'
                )}
              >
                <Mail size={10} /> E-mail ({counts.mineracaoEmail})
              </button>
              {(mineracaoSubFilter === 'instagram' || counts.mineracaoInstagram > 0) && (
                <>
                  <span className="text-fg-faint">·</span>
                  <button
                    type="button"
                    onClick={() => setMineracaoSubFilter('instagram')}
                    className={cn(
                      'px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors cursor-pointer flex items-center gap-0.5',
                      mineracaoSubFilter === 'instagram' ? 'text-pink-500 font-bold underline' : 'text-fg-subtle hover:text-pink-500'
                    )}
                  >
                    <InstagramLogoIcon size={10} /> Instagram ({counts.mineracaoInstagram})
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {channelFilter === 'anuncio' && (
          <div className="flex items-center justify-between text-[11px] pt-1">
            <span className="text-fg-faint font-semibold uppercase text-[10px] tracking-wider">Origem paga:</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setAnuncioSubFilter('all')}
                className={cn(
                  'px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors cursor-pointer',
                  anuncioSubFilter === 'all' ? 'text-fg font-bold underline decoration-brand-ink' : 'text-fg-subtle hover:text-fg'
                )}
              >
                Todos
              </button>
              <span className="text-fg-faint">·</span>
              <button
                type="button"
                onClick={() => setAnuncioSubFilter('meta_ads')}
                className={cn(
                  'px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors cursor-pointer flex items-center gap-0.5',
                  anuncioSubFilter === 'meta_ads' ? 'text-blue-500 font-bold underline' : 'text-fg-subtle hover:text-blue-500'
                )}
              >
                <MetaInfinityIcon size={10} /> Meta Ads ({counts.anuncioMetaAds})
              </button>
              <span className="text-fg-faint">·</span>
              <button
                type="button"
                onClick={() => setAnuncioSubFilter('google_ads')}
                className={cn(
                  'px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors cursor-pointer flex items-center gap-0.5',
                  anuncioSubFilter === 'google_ads' ? 'text-red-500 font-bold underline' : 'text-fg-subtle hover:text-red-500'
                )}
              >
                <Search size={10} /> Google Ads ({counts.anuncioGoogleAds})
              </button>
            </div>
          </div>
        )}

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

      {/* Banner de Erro de Conexão com o Banco de Dados */}
      {error && (
        <div className="mx-2 mb-2 p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs flex items-center justify-between">
          <div className="flex items-center gap-1.5 min-w-0">
            <AlertCircle size={14} className="shrink-0" />
            <span className="truncate">{error}</span>
          </div>
          <button
            type="button"
            onClick={() => refresh(false)}
            className="text-micro font-bold underline shrink-0 hover:text-rose-300 cursor-pointer ml-2"
          >
            Tentar de novo
          </button>
        </div>
      )}

      {/* Lista de Conversas com Scroll */}
      <div className="scroll-thin flex-1 overflow-y-auto p-2 space-y-1 pb-[calc(4rem+env(safe-area-inset-bottom))] lg:pb-2">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-fg-faint text-center px-4">
            <MessageSquare size={28} className="opacity-40" />
            <p className="text-body font-semibold text-fg-muted">Nenhuma conversa encontrada</p>
            <p className="text-micro text-fg-subtle">
              {search || sourceFilter || channelFilter !== 'all' || statusFilter !== 'all'
                ? 'Tente ajustar os filtros ou termo de busca acima.'
                : 'Novos leads e mensagens recebidas aparecerão aqui em tempo real.'}
            </p>
          </div>
        ) : (
          filtered.map(conv => {
            const isActive = String(conv.id) === activeId
            const displayName = conv.name || conv.phone
            const initials = displayName.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase()
            const timeInfo = formatMessageTimestamp(conv.lastMessageAt || conv.createdAt)

            return (
              <Link
                key={conv.id}
                href={sourceFilter ? `/inbox/${conv.id}?source=${encodeURIComponent(sourceFilter)}` : `/inbox/${conv.id}`}
                scroll={false}
                className="focus-ring block rounded-xl"
              >
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
                        <span suppressHydrationWarning className="text-[11px] text-fg-subtle font-mono font-medium" title={timeInfo.full}>
                          {timeInfo.time}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  {/* Linha 2: Badges de Origem, Janela Meta (24h/72h) e Status do Bot */}
                  <div className="flex flex-wrap items-center gap-1">
                    <PlatformBadge
                      origins={conv.allOrigins}
                      platform={conv.platform}
                      trackingSource={conv.trackingSource}
                      eventType={conv.eventType}
                    />
                    <MetaWindowBadge lead={conv} />
                    <EmailEngagementBadge engagement={conv.emailEngagement} />
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
                      <span suppressHydrationWarning className="text-[10px] text-fg-faint shrink-0 font-mono">
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
