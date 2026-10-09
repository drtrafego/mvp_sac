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
  Loader2,
  RefreshCw,
  UserRound,
  UserRoundCheck,
  UserRoundMinus,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'
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
      className={cn('focus-ring inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-line-default bg-surface-raised px-3 text-micro font-semibold text-fg transition-colors hover:border-brand-solid/40 hover:bg-surface-overlay hover:text-brand-ink', compact && 'w-full')}
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

  return (
    <div className="flex flex-col gap-6 pb-3">
      <PageHeader
        title="Atender agora"
        icon={<Inbox size={20} strokeWidth={1.7} />}
        eyebrow={<span className="text-micro font-medium text-fg-subtle">Atendimento <span className="mx-1 text-fg-faint">/</span> {companyName}</span>}
        description="Veja quem precisa de uma pessoa, o que foi prometido e quais prazos precisam da sua atenção."
        actions={<button type="button" onClick={refresh} disabled={loading} className="focus-ring inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-xl border border-line-default bg-surface-panel px-4 text-micro font-semibold text-fg transition-colors hover:bg-surface-raised disabled:cursor-wait disabled:opacity-60">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
          {loading && data ? 'Atualizando' : 'Atualizar'}
        </button>}
      />

      <section aria-label="Visões de atendimento" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {attentionCards.map(({ view, title, description, icon: Icon, tone }) => {
          const selected = query.view === view
          return (
            <button
              key={view}
              type="button"
              aria-pressed={selected}
              onClick={() => selectView(view)}
              className={cn('focus-ring group relative overflow-hidden rounded-2xl border bg-surface-panel p-4 text-left transition-colors sm:p-5', selected ? 'border-brand-solid/50 bg-surface-raised shadow-xs' : 'border-line-subtle hover:border-line-strong hover:bg-surface-raised')}
            >
              <div className="mb-4 flex items-center justify-between gap-2">
                <span className={cn('flex h-9 w-9 items-center justify-center rounded-xl border border-line-subtle bg-surface-inset', tone)}><Icon size={17} strokeWidth={1.7} /></span>
                {selected ? <span className="rounded-full bg-brand-solid/10 p-1 text-brand-ink"><Check size={12} aria-hidden="true" /></span> : <ArrowUpRight size={14} className="text-fg-faint transition-colors group-hover:text-fg-muted" aria-hidden="true" />}
              </div>
              {counts ? <p className="text-metric tabular-nums text-fg">{counts[view]}</p> : <div className="mb-1 h-8 w-12 animate-pulse rounded bg-surface-overlay" aria-hidden="true" />}
              <p className="mt-2 text-body font-semibold leading-snug text-fg">{title}</p>
              <p className="mt-1 hidden text-micro text-fg-subtle sm:block">{description}</p>
            </button>
          )
        })}
      </section>

      {counts && (loading || error) && <p className="-mt-3 px-1 text-micro text-fg-subtle">{loading ? 'Atualizando a fila. Os indicadores exibidos são da última consulta concluída.' : 'Os indicadores exibidos são da última consulta concluída.'}</p>}

      <section aria-labelledby="attention-list-title" className="overflow-hidden rounded-2xl border border-line-subtle bg-surface-panel shadow-xs">
        <div className="flex flex-col justify-between gap-4 border-b border-line-subtle px-4 py-4 sm:flex-row sm:items-center sm:px-5">
          <div className="min-w-0">
            <h2 id="attention-list-title" ref={pageHeading} tabIndex={-1} className="text-h2 text-fg outline-none">{viewLabels[query.view]}</h2>
            <p className="mt-1 text-micro text-fg-subtle">Priorize os prazos vencidos e abra a conversa com o contexto à vista.</p>
          </div>
          <div className="inline-flex shrink-0 self-start rounded-xl border border-line-subtle bg-surface-inset p-1 sm:self-auto" aria-label="Filtrar atendimentos">
            <button type="button" aria-pressed={query.view === 'all'} onClick={() => selectView('all')} className={cn('focus-ring inline-flex min-h-9 items-center gap-2 rounded-lg px-3 text-micro font-semibold transition-colors', query.view === 'all' ? 'bg-surface-overlay text-fg shadow-xs' : 'text-fg-muted hover:text-fg')}>
              Todos {counts && <span className="rounded-md bg-surface-panel px-1.5 py-0.5 text-[10px] tabular-nums">{counts.all}</span>}
            </button>
            <button type="button" aria-pressed={query.view === 'mine'} onClick={() => selectView('mine')} disabled={!currentMemberId} title={!currentMemberId ? 'Meus atendimentos fica disponível para um membro ativo da empresa.' : undefined} className={cn('focus-ring inline-flex min-h-9 items-center gap-2 rounded-lg px-3 text-micro font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40', query.view === 'mine' ? 'bg-surface-overlay text-fg shadow-xs' : 'text-fg-muted hover:text-fg')}>
              Meus {counts && <span className="rounded-md bg-surface-panel px-1.5 py-0.5 text-[10px] tabular-nums">{counts.mine}</span>}
            </button>
          </div>
        </div>

        <div aria-live="polite" className="sr-only">{loading ? 'Carregando fila de atendimento.' : error ? 'Erro ao carregar a fila.' : data ? `${data.total} atendimentos nesta visão. Página ${data.page} de ${pageCount}.` : ''}</div>

        {error && <div role="alert" className="m-4 flex flex-col gap-3 rounded-xl border border-st-negativo/25 bg-st-negativo/5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3"><AlertCircle size={17} className="mt-0.5 shrink-0 text-st-negativo" /><div><p className="text-body font-semibold text-fg">Não foi possível atualizar a fila</p><p className="mt-1 text-micro text-fg-muted">{error}</p>{data && <p className="mt-1 text-micro text-fg-muted">Os dados abaixo são da última atualização concluída.</p>}</div></div>
          <button type="button" onClick={refresh} disabled={loading} className="focus-ring min-h-10 shrink-0 rounded-lg border border-line-default bg-surface-panel px-3 text-micro font-semibold text-fg disabled:opacity-50">Tentar novamente</button>
        </div>}

        {loading && !data && <QueueSkeleton />}

        {!loading && !error && data?.items.length === 0 && <div className="flex flex-col items-center px-6 py-14 text-center">
          <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-brand-solid/20 bg-brand-solid/10 text-brand-ink"><CircleCheck size={23} strokeWidth={1.6} /></span>
          <h3 className="text-h2 text-fg">{query.view === 'all' ? 'Nenhum atendimento exige atenção agora' : 'Nenhum atendimento nesta visão'}</h3>
          <p className="mt-2 max-w-[45ch] text-body text-fg-muted">{query.view === 'all' ? 'Os atendimentos sem alertas continuam disponíveis em Conversas.' : 'Você pode consultar outra visão ou abrir todas as conversas.'}</p>
          <Link href="/inbox" className="focus-ring mt-5 inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-line-default px-4 text-micro font-semibold text-fg hover:bg-surface-raised">Ir para Conversas <ArrowUpRight size={14} /></Link>
        </div>}

        {data && data.items.length > 0 && <div aria-busy={loading} className={cn('transition-opacity', loading && 'opacity-65')}>
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full min-w-[860px] text-left">
              <caption className="sr-only">{viewLabels[query.view]}</caption>
              <thead className="bg-surface-inset text-[11px] font-medium text-fg-subtle">
                <tr><th scope="col" className="px-5 py-3">Contato</th><th scope="col" className="px-4 py-3">Por que atender</th><th scope="col" className="px-4 py-3">Responsável</th><th scope="col" className="px-4 py-3">Prazo e próxima ação</th><th scope="col" className="px-5 py-3"><span className="sr-only">Abrir conversa</span></th></tr>
              </thead>
              <tbody className="divide-y divide-line-subtle">
                {data.items.map(item => <tr key={item.leadId} className="align-top transition-colors hover:bg-surface-raised/50">
                  <td className="max-w-[240px] px-5 py-5"><ContactIdentity item={item} /></td>
                  <td className="max-w-[260px] px-4 py-5"><ReasonList item={item} />{item.requestSummary && <p className="mt-2 line-clamp-2 text-micro text-fg-subtle" title={item.requestSummary}>{item.requestSummary}</p>}</td>
                  <td className="max-w-[190px] px-4 py-5"><p className={cn('text-micro font-medium', item.humanOwnerName ? 'text-fg-muted' : 'text-st-atencao')}>{item.humanOwnerName || 'Sem responsável'}</p></td>
                  <td className="max-w-[270px] px-4 py-5"><p className={cn('flex items-center gap-1.5 text-micro font-semibold', item.overdue ? 'text-st-negativo' : 'text-fg')}><Clock3 size={12} />{dueLabel(item.dueAt, data.now)}</p><p className="mt-2 line-clamp-2 text-micro leading-relaxed text-fg-muted" title={item.nextAction || undefined}>{item.nextAction || 'Próxima ação não registrada'}</p></td>
                  <td className="px-5 py-5 text-right"><OpenConversation leadId={item.leadId} view={query.view} page={data.page} /></td>
                </tr>)}
              </tbody>
            </table>
          </div>

          <div className="divide-y divide-line-subtle lg:hidden">
            {data.items.map(item => <article key={item.leadId} className="space-y-4 p-4 sm:p-5">
              <ContactIdentity item={item} />
              <ReasonList item={item} />
              {item.requestSummary && <p className="line-clamp-2 text-micro text-fg-muted">{item.requestSummary}</p>}
              <div className="grid grid-cols-2 gap-4 rounded-xl border border-line-subtle bg-surface-inset p-3">
                <div><p className="mb-1 text-[11px] text-fg-subtle">Responsável</p><p className={cn('text-micro font-medium', item.humanOwnerName ? 'text-fg' : 'text-st-atencao')}>{item.humanOwnerName || 'Sem responsável'}</p></div>
                <div><p className="mb-1 text-[11px] text-fg-subtle">Prazo</p><p className={cn('text-micro font-semibold', item.overdue ? 'text-st-negativo' : 'text-fg')}>{dueLabel(item.dueAt, data.now)}</p></div>
                <div className="col-span-2 border-t border-line-subtle pt-3"><p className="mb-1 text-[11px] text-fg-subtle">Próxima ação</p><p className="text-body leading-relaxed text-fg">{item.nextAction || 'Próxima ação não registrada'}</p></div>
              </div>
              <OpenConversation leadId={item.leadId} view={query.view} page={data.page} compact />
            </article>)}
          </div>
        </div>}

        {data && data.total > 0 && <footer className="flex flex-col items-start justify-between gap-3 border-t border-line-subtle bg-surface-inset/40 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
          <p id="attention-pagination" className="text-micro text-fg-muted">{firstItem > 0 ? `${firstItem}–${lastItem} de ${data.total}` : `Nenhum item nesta página · ${data.total} atendimentos`}<span className="ml-2 text-fg-subtle">Página {data.page} de {pageCount}</span></p>
          <nav aria-label="Páginas da fila" className="flex w-full items-center justify-between gap-2 sm:w-auto">
            <button type="button" onClick={() => changePage(data.page - 1)} disabled={loading || data.page <= 1} aria-describedby="attention-pagination" className="focus-ring inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-line-default bg-surface-panel px-3 text-micro font-semibold text-fg hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"><ChevronLeft size={14} />Anterior</button>
            <button type="button" onClick={() => changePage(data.page + 1)} disabled={loading || !data.hasMore} aria-describedby="attention-pagination" className="focus-ring inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-line-default bg-surface-panel px-3 text-micro font-semibold text-fg hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40">Próxima<ChevronRight size={14} /></button>
          </nav>
        </footer>}
      </section>

      <div className="flex flex-col justify-between gap-2 px-1 text-micro text-fg-subtle sm:flex-row">
        <div className="space-y-1"><p>Um atendimento pode aparecer em mais de uma visão.</p><p>Atualiza automaticamente a cada minuto, com a aba visível.</p></div>
        {snapshot && <p className="inline-flex shrink-0 items-center gap-1.5 self-start">{loading && data ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}Última consulta às {new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(new Date(snapshot.response.now))}</p>}
      </div>
    </div>
  )
}
