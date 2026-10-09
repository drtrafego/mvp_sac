'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  ArrowUpRight,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clock3,
  Inbox,
  MessageSquare,
  Sparkles,
  Loader2,
  RefreshCw,
  UserRound,
  UserRoundCheck,
  UserRoundMinus,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AttentionItem, AttentionResponse, AttentionView } from '@/lib/sac-attention-types'

const PAGE_SIZE = 25

const attentionCards = [
  { view: 'human', title: 'Precisam de humano', description: 'Atendimentos manuais e transbordos', icon: UserRoundCheck, tone: 'text-st-info' },
  { view: 'unassigned', title: 'Sem responsável', description: 'Atendimentos acionáveis sem dono', icon: UserRoundMinus, tone: 'text-st-atencao' },
  { view: 'today', title: 'Vencem hoje', description: 'Próximo prazo registrado para hoje', icon: CalendarClock, tone: 'text-brand-ink' },
  { view: 'overdue', title: 'Vencidos', description: 'Compromissos com prazo anterior', icon: Clock3, tone: 'text-st-negativo' },
] as const

const viewLabels: Record<AttentionView, string> = {
  all: 'Todos os atendimentos que precisam de atenção',
  human: 'Precisam de atendimento humano',
  unassigned: 'Aguardando um responsável',
  overdue: 'Compromissos vencidos',
  today: 'Compromissos de hoje',
  mine: 'Meus atendimentos',
}

const stateLabels: Record<string, string> = {
  aberto: 'Aberto',
  em_atendimento: 'Em atendimento',
  aguardando_retorno: 'Aguardando retorno',
  transbordo: 'Precisa de humano',
  resolvido: 'Resolvido',
  reaberto: 'Reaberto',
}

const channelLabels: Record<string, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  instagram_direct: 'Instagram',
  email: 'E-mail',
  facebook: 'Facebook',
  messenger: 'Messenger',
}

type QueueSnapshot = { response: AttentionResponse; view: AttentionView; requestedPage: number }

function localDay(value: string): string | null {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(date)
}

function dueLabel(dueAt: string | null, now: string | undefined): string {
  if (!dueAt) return 'Sem prazo registrado'
  const date = new Date(dueAt)
  if (!Number.isFinite(date.getTime())) return 'Prazo indisponível'
  if (now && localDay(dueAt) === localDay(now)) return 'Hoje'
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'short', year: 'numeric' }).format(date)
}

function ChannelLabel({ channel }: { channel: string | null }) {
  if (!channel) return null
  return <span className="rounded-md border border-line-subtle bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium text-fg-muted">{channelLabels[channel] ?? channel}</span>
}

function ContactIdentity({ item }: { item: AttentionItem }) {
  const name = item.name?.trim() || item.phone || `Atendimento #${item.leadId}`
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-line-subtle bg-surface-raised text-fg-muted">
        <UserRound size={17} strokeWidth={1.6} />
      </span>
      <div className="min-w-0 space-y-1">
        <p className="truncate text-body font-semibold text-fg" title={name}>{name}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {item.name?.trim() && item.phone && <span className="text-micro text-fg-subtle">{item.phone}</span>}
          <ChannelLabel channel={item.channel} />
        </div>
      </div>
    </div>
  )
}

function ReasonList({ item }: { item: AttentionItem }) {
  const state = item.sacCaseState || 'aberto'
  return (
    <div className="space-y-1.5">
      <span className="inline-flex rounded-md border border-line-subtle bg-surface-inset px-2 py-1 text-[11px] font-medium text-fg-muted">
        {stateLabels[state] ?? state.replaceAll('_', ' ')}
      </span>
      <p className={cn('text-micro leading-relaxed', item.overdue ? 'text-st-negativo' : 'text-fg-muted')}>
        {item.reasons.join(' · ')}
      </p>
    </div>
  )
}

function OpenConversation({ leadId, view, page, compact = false }: { leadId: number; view: AttentionView; page: number; compact?: boolean }) {
  return (
    <Link
      href={`/inbox/${leadId}?context=1&from=attention&attentionView=${view}&attentionPage=${page}`}
      className={cn('attention-open-conversation focus-ring', compact && 'w-full')}
    >
      Abrir atendimento <ArrowUpRight size={14} aria-hidden="true" />
    </Link>
  )
}

function QueueSkeleton() {
  return (
    <div className="divide-y divide-line-subtle" aria-hidden="true">
      {[0, 1, 2, 3].map(row => (
        <div key={row} className="flex animate-pulse items-center gap-4 px-5 py-6">
          <div className="h-10 w-10 shrink-0 rounded-xl bg-surface-overlay" />
          <div className="flex-1 space-y-2"><div className="h-3 w-1/3 rounded bg-surface-overlay" /><div className="h-2.5 w-1/2 rounded bg-surface-overlay" /></div>
          <div className="hidden h-8 w-28 rounded-lg bg-surface-overlay sm:block" />
        </div>
      ))}
    </div>
  )
}

export function AttentionQueue({ companyName, initialView = 'all', initialPage = 1 }: { companyName: string; initialView?: AttentionView; initialPage?: number }) {
  const [query, setQuery] = useState<{ view: AttentionView; page: number }>({ view: initialView, page: initialPage })
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const requestSequence = useRef(0)
  const activeRequest = useRef<AbortController | null>(null)
  const pageHeading = useRef<HTMLHeadingElement>(null)
  const focusAfterLoad = useRef(false)
  const [selectedLeadId, setSelectedLeadId] = useState<number | null>(null)
  const contextPanel = useRef<HTMLElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    activeRequest.current = controller
    const requestId = ++requestSequence.current
    const params = new URLSearchParams({ view: query.view, page: String(query.page), pageSize: String(PAGE_SIZE) })

    async function loadQueue() {
      setLoading(true)
      setError(null)
      try {
        const response = await fetch(`/api/inbox/attention?${params}`, { cache: 'no-store', signal: controller.signal })
        const payload: AttentionResponse & { error?: string } = await response.json()
        if (!response.ok) throw new Error(payload.error || 'Não foi possível carregar a fila de atendimento.')
        if (!Array.isArray(payload.items) || !payload.counts || !Number.isSafeInteger(payload.total) || payload.total < 0 || !Number.isSafeInteger(payload.pageSize) || payload.pageSize < 1) throw new Error('A fila retornou dados incompletos. Tente atualizar.')
        if (controller.signal.aborted || requestId !== requestSequence.current) return
        const lastPage = Math.max(1, Math.ceil(payload.total / payload.pageSize))
        if (query.page > lastPage) {
          // Um atendimento pode ser resolvido enquanto esta página está aberta.
          // Busque a última página existente em vez de prender o usuário no vazio.
          requestSequence.current += 1
          setQuery({ view: query.view, page: lastPage })
          return
        }
        setSnapshot({ response: payload, view: query.view, requestedPage: query.page })
        if (focusAfterLoad.current) {
          focusAfterLoad.current = false
          pageHeading.current?.focus({ preventScroll: true })
        }
      } catch (err: unknown) {
        if (controller.signal.aborted || requestId !== requestSequence.current) return
        setError(err instanceof Error ? err.message : 'Não foi possível carregar a fila de atendimento.')
      } finally {
        if (activeRequest.current === controller) activeRequest.current = null
        if (!controller.signal.aborted && requestId === requestSequence.current) setLoading(false)
      }
    }

    void loadQueue()
    return () => {
      controller.abort()
      if (activeRequest.current === controller) activeRequest.current = null
    }
  }, [query.view, query.page, refreshVersion])

  useEffect(() => {
    function refreshAutomatically(force = false) {
      if (document.visibilityState !== 'visible') return
      // Não interrompa uma consulta lenta só porque o minuto seguinte chegou.
      if (!force && activeRequest.current && !activeRequest.current.signal.aborted) return
      activeRequest.current?.abort()
      requestSequence.current += 1
      focusAfterLoad.current = false
      setLoading(true)
      setError(null)
      setRefreshVersion(current => current + 1)
    }

    const interval = window.setInterval(() => refreshAutomatically(), 60_000)
    const onVisibilityChange = () => refreshAutomatically(true)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  const isCurrentSnapshot = snapshot?.view === query.view && snapshot.requestedPage === query.page
  const data = isCurrentSnapshot ? snapshot.response : null
  const counts = snapshot?.response.counts
  const currentMemberId = snapshot?.response.currentMemberId ?? null
  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1
  const firstItem = data && data.total > 0 && data.items.length > 0 ? (data.page - 1) * data.pageSize + 1 : 0
  const lastItem = data ? firstItem > 0 ? firstItem + data.items.length - 1 : 0 : 0

  function selectView(view: AttentionView) {
    if (view === query.view && query.page === 1) return
    activeRequest.current?.abort()
    requestSequence.current += 1
    setLoading(true)
    setError(null)
    setQuery({ view, page: 1 })
  }

  function changePage(page: number) {
    if (loading) return
    activeRequest.current?.abort()
    requestSequence.current += 1
    focusAfterLoad.current = true
    setLoading(true)
    setError(null)
    setQuery(current => ({ ...current, page }))
  }

  function refresh() {
    activeRequest.current?.abort()
    requestSequence.current += 1
    setLoading(true)
    setError(null)
    setRefreshVersion(current => current + 1)
  }

  const selectedItem = data?.items.find(item => item.leadId === selectedLeadId) ?? data?.items[0] ?? null
  const selectedName = selectedItem?.name?.trim() || selectedItem?.phone || 'Atendimento'
  const updatedAt = snapshot ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(new Date(snapshot.response.now)) : null

  function inspect(item: AttentionItem) {
    setSelectedLeadId(item.leadId)
    if (window.matchMedia('(max-width: 1000px)').matches) {
      contextPanel.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' })
    }
  }

  return (
    <div className="attention-studio">
      <header className="attention-hero">
        <div className="attention-hero-copy">
          <p className="attention-eyebrow"><span className="attention-live-dot" /> CENTRAL DE ATENDIMENTO <span className="attention-eyebrow-company">/ {companyName}</span></p>
          <h1>O próximo cuidado<br /><span>começa aqui.</span></h1>
          <p className="attention-hero-description">Compromissos, pessoas e próximos passos.<br className="hidden sm:block" /> Uma visão clara de quem precisa de você.</p>
          <div className="attention-hero-footer"><span><Inbox size={14} /> Atender agora</span><span className="attention-hero-divider" /><span>{updatedAt ? `Consultado às ${updatedAt}` : 'Consultando atendimentos'}</span></div>
        </div>
        <div className="attention-hero-priority">
          <div className="attention-priority-icon"><Sparkles size={21} strokeWidth={1.5} /></div>
          <p className="attention-eyebrow">COMECE PELO QUE IMPORTA</p>
          <p className="attention-priority-number">{counts ? String(counts.overdue).padStart(2, '0') : '—'}<span>prazos vencidos</span></p>
          <p className="attention-priority-copy">{counts?.overdue ? 'Confira os compromissos que precisam de um retorno.' : counts ? 'Nenhum prazo vencido na última consulta.' : 'Os dados aparecerão após a consulta.'}</p>
          <button type="button" onClick={() => selectView('overdue')} className="attention-priority-link">Ver prioridades <ArrowUpRight size={17} /></button>
        </div>
      </header>

      <section className="attention-signals" aria-label="Visões de atendimento">
        {attentionCards.map(({ view, title, icon: Icon }) => <button key={view} type="button" className={cn('attention-signal', `attention-signal-${view}`, query.view === view && 'is-active')} aria-pressed={query.view === view} onClick={() => selectView(view)}>
          <span className="attention-signal-icon"><Icon size={20} strokeWidth={1.6} /></span>
          <span className="attention-signal-copy"><span>{title}</span><strong>{counts ? String(counts[view]).padStart(2, '0') : '—'}</strong></span>
          <ArrowUpRight size={15} className="attention-signal-arrow" />
        </button>)}
      </section>
      {counts && (loading || error) && <p className="attention-stale">{loading ? 'Atualizando. ' : ''}Os indicadores são da última consulta concluída.</p>}

      <div className="attention-workspace">
        <section className="attention-queue" aria-labelledby="attention-list-title">
          <div className="attention-queue-heading">
            <div><p className="attention-eyebrow">SUA FILA DE ATENDIMENTO</p><h2 id="attention-list-title" ref={pageHeading} tabIndex={-1}>{viewLabels[query.view]}</h2></div>
            <button type="button" className="attention-icon-button" onClick={refresh} disabled={loading} aria-label="Atualizar fila"><RefreshCw size={17} className={loading ? 'animate-spin' : ''} /></button>
          </div>
          <div className="attention-queue-toolbar">
            <div className="attention-tabs" aria-label="Filtrar atendimentos">
              <button type="button" aria-pressed={query.view === 'all'} onClick={() => selectView('all')} className={query.view === 'all' ? 'is-active' : ''}>Todos <span>{counts?.all ?? '—'}</span></button>
              <button type="button" aria-pressed={query.view === 'mine'} onClick={() => selectView('mine')} disabled={!currentMemberId} title={!currentMemberId ? 'Disponível para um membro ativo da empresa.' : undefined} className={query.view === 'mine' ? 'is-active' : ''}>Meus <span>{counts?.mine ?? '—'}</span></button>
            </div>
            <span className="attention-order"><Clock3 size={13} /> Prazos primeiro</span>
          </div>
          <div aria-live="polite" className="sr-only">{loading ? 'Carregando fila.' : error ? 'Erro ao carregar a fila.' : data ? `${data.total} atendimentos. Página ${data.page} de ${pageCount}.` : ''}</div>
          {error && <div role="alert" className="attention-error"><AlertCircle size={18} /><div><strong>Não foi possível atualizar</strong><p>{error}</p>{data && <p>Os dados exibidos são da última consulta concluída.</p>}<button type="button" onClick={refresh} disabled={loading}>Tentar novamente</button></div></div>}
          {loading && !data && <QueueSkeleton />}
          {!loading && !error && data?.items.length === 0 && <div className="attention-empty"><CircleCheck size={38} strokeWidth={1.3} /><h3>Nada pendente nesta visão</h3><p>Os demais atendimentos continuam disponíveis em Conversas.</p><Link href="/inbox">Ir para Conversas <ArrowUpRight size={15} /></Link></div>}
          {data && data.items.length > 0 && <div className={cn('attention-rows', loading && 'is-loading')} aria-busy={loading}>
            {data.items.map((item, index) => <button type="button" key={item.leadId} onClick={() => inspect(item)} aria-pressed={selectedItem?.leadId === item.leadId} aria-controls="attention-context-panel" className={cn('attention-row', selectedItem?.leadId === item.leadId && 'is-selected', item.overdue && 'is-overdue')}>
              <span className="attention-row-index">{String((data.page - 1) * data.pageSize + index + 1).padStart(2, '0')}</span>
              <span className="attention-row-body"><ContactIdentity item={item} /><span className="attention-row-summary">{item.requestSummary || item.nextAction || item.reasons.join(' · ') || 'Consulte o contexto deste atendimento'}</span><span className="attention-row-meta"><span className={cn('attention-reason', item.overdue && 'is-overdue')}>{item.overdue ? 'Prazo vencido' : stateLabels[item.sacCaseState || 'aberto'] || 'Atendimento aberto'}</span><span><UserRound size={11} />{item.humanOwnerName || 'Sem responsável'}</span></span></span>
              <span className="attention-row-end"><span className={item.overdue ? 'is-overdue' : ''}>{dueLabel(item.dueAt, data.now)}</span><ChevronRight size={19} /></span>
            </button>)}
          </div>}
          {data && data.total > 0 && <footer className="attention-pagination"><p id="attention-pagination">{firstItem}–{lastItem} de {data.total}<span> · Página {data.page} de {pageCount}</span></p><nav aria-label="Páginas da fila"><button type="button" aria-label="Página anterior" onClick={() => changePage(data.page - 1)} disabled={loading || data.page <= 1}><ChevronLeft size={17} /></button><button type="button" aria-label="Próxima página" onClick={() => changePage(data.page + 1)} disabled={loading || !data.hasMore}><ChevronRight size={17} /></button></nav></footer>}
        </section>

        <aside className="attention-context" id="attention-context-panel" ref={contextPanel} aria-label="Contexto do atendimento selecionado">
          <div className="attention-context-top"><span className="attention-eyebrow">CONTEXTO EM FOCO</span><MessageSquare size={16} /></div>
          {selectedItem ? <>
            <div className="attention-context-identity"><span className="attention-avatar">{selectedName.split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase()}</span><ChannelLabel channel={selectedItem.channel} /><h2>{selectedName}</h2><p>{selectedItem.phone}</p></div>
            <div className="attention-context-section"><p className="attention-eyebrow">POR QUE ATENDER</p><ReasonList item={selectedItem} /></div>
            <div className="attention-context-section"><p className="attention-eyebrow">O QUE O CLIENTE PRECISA</p><p className="attention-context-description">{selectedItem.requestSummary || 'Nenhum resumo registrado. Consulte a conversa para entender o pedido.'}</p></div>
            <div className={cn('attention-next-step', selectedItem.overdue && 'is-overdue')}><div><CalendarClock size={16} /><span>PRÓXIMO PASSO</span></div><p>{selectedItem.nextAction || 'Próxima ação não registrada'}</p><span className="attention-next-deadline"><Clock3 size={13} />{dueLabel(selectedItem.dueAt, data?.now)}{selectedItem.overdue ? ' · Vencido' : ''}</span></div>
            <div className="attention-context-owner"><span className="attention-owner-avatar"><UserRound size={16} /></span><div><span>RESPONSÁVEL</span><p>{selectedItem.humanOwnerName || 'Ainda não atribuído'}</p></div></div>
            <OpenConversation leadId={selectedItem.leadId} view={query.view} page={data?.page ?? query.page} compact />
            <p className="attention-context-note">A conversa abre com o Contexto à vista.</p>
          </> : <div className="attention-context-placeholder"><MessageSquare size={35} strokeWidth={1.2} /><h3>Uma conversa, todo o contexto.</h3><p>Selecione um atendimento para consultar o pedido, o responsável e o próximo passo.</p></div>}
        </aside>
      </div>
      <footer className="attention-footnote"><span><span className="attention-live-dot" /> Consulta automática a cada minuto com a aba visível.</span><span>{loading ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} {updatedAt ? `Última consulta às ${updatedAt}` : 'Aguardando consulta'}</span></footer>
    </div>
  )
}
