'use client'

import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import {
  ArrowLeft,
  RefreshCw,
  Send,
  Pause,
  Play,
  Loader2,
  Info,
  X,
  ExternalLink,
  Sparkles,
  Bot,
  UserCog,
  CalendarDays,
  ChevronUp,
  Database,
  Pencil,
} from 'lucide-react'
import Link from 'next/link'
import { MessageList, type InboxMessage } from './MessageBubble'
import { LeadTags } from './LeadTags'
import { ChannelIcon, ChannelBadge, PlatformBadge, BotStatusPill, EmailEngagementBadge } from './ChannelBadge'
import { MetaWindowBanner, getMetaWindowInfo } from './MetaWindowBadge'
import { cn } from '@/lib/utils'
import type { EmailEngagement } from '@/lib/email-engagement'

const ACTIVE_CHAT_POLL_MS = 3_000

export interface ChatLead {
  id: number
  phone: string
  name: string | null
  email: string | null
  company: string | null
  notes: string | null
  eventType: string
  status: string | null
  productName: string | null
  productValue: number | null
  platform: string | null
  channel: string
  botPaused: boolean
  botPausedAt: string | null
  botPausedBy: string | null
  trackingSource: string | null
  utmCampaign: string | null
  adsetName: string | null
  adName: string | null
  createdAt: string | null
  firstContactAt: string | null
  lastMessageAt?: string | null
  lastInboundAt?: string | null
  lastOutboundAt?: string | null
  // Nome de persona do bot desta empresa (ex.: "Clara" pro Dr. Lucas), vindo
  // de companies.agentDisplayName via sync-agents.ts. Nulo = nenhum agente
  // resolvido ainda; a UI cai no fallback genérico "Bot IA" (22/09/2026).
  agentDisplayName?: string | null
  emailEngagement?: EmailEngagement | null
  agentConversationId?: string | null
  agentCostUsd?: string | null
  agentInputTokens?: number | null
  agentOutputTokens?: number | null
  agentSyncedAt?: string | null
  reservation?: {
    id: string
    date: string
    reservedTime: string | null
    arrivalTime: string | null
    people: number | null
    totalValue: string | null
    status: string
    notes: string | null
    unifiedTables: boolean | null
    updatedAt: string | null
  } | null
}

export interface MirroredAppointment {
  nativeId: string
  consultationAt: string
  status: string
  origin: string | null
  cancelledAt: string | null
}

function formatBRL(centavos: number | null | undefined) {
  if (centavos == null) return 'R$ 0,00'
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function ChatWindow({
  lead,
  initialMessages,
  appointments = [],
  initialHistory,
  backHref = '/inbox',
}: {
  lead: ChatLead
  initialMessages: InboxMessage[]
  appointments?: MirroredAppointment[]
  initialHistory: { hasMore: boolean; nextCursor: string | null }
  backHref?: '/inbox' | '/instagram'
}) {
  const [messages, setMessages] = useState<InboxMessage[]>(initialMessages)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [hasMoreHistory, setHasMoreHistory] = useState(initialHistory.hasMore)
  const [historyCursor, setHistoryCursor] = useState(initialHistory.nextCursor)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [leadName, setLeadName] = useState(lead.name)
  const [isEditingName, setIsEditingName] = useState(false)
  const [editingName, setEditingName] = useState(lead.name ?? '')
  const [savingName, setSavingName] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)

  // Controle de Pausa do Bot
  const [botPaused, setBotPaused] = useState(lead.botPaused)
  const [pauseLoading, setPauseLoading] = useState(false)
  const [pauseToast, setPauseToast] = useState<string | null>(null)

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const loadingHistoryRef = useRef(false)
  const didInitialScrollRef = useRef(false)
  const shouldScrollToBottomRef = useRef(true)
  const prependScrollHeightRef = useRef<number | null>(null)

  const refresh = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true)
      try {
        const res = await fetch(`/api/inbox/${lead.id}`, { cache: 'no-store' })
        if (res.ok) {
          const data = await res.json()
          if (data.messages) {
            const container = messagesContainerRef.current
            shouldScrollToBottomRef.current = !!container
              && container.scrollHeight - container.scrollTop - container.clientHeight < 120
            setMessages(prev => {
              const merged = new Map(prev.map(message => [message.id, message]))
              for (const message of data.messages as InboxMessage[]) merged.set(message.id, message)
              return [...merged.values()].sort((a, b) => {
                const timeDiff = new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
                return timeDiff || a.id - b.id
              })
            })
          }
          if (data.lead && typeof data.lead.botPaused === 'boolean') {
            setBotPaused(data.lead.botPaused)
          }
          if (data.lead && 'name' in data.lead) {
            setLeadName(data.lead.name ?? null)
          }
        }
      } catch {
        /* silencioso */
      } finally {
        if (!silent) setRefreshing(false)
      }
    },
    [lead.id]
  )

  useEffect(() => {
    if (!shouldScrollToBottomRef.current || !messagesContainerRef.current) return
    messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight
    shouldScrollToBottomRef.current = false
    didInitialScrollRef.current = true
  }, [messages])

  useEffect(() => {
    const t = setTimeout(() => {
      setLeadName(lead.name)
      setEditingName(lead.name ?? '')
      setIsEditingName(false)
      setNameError(null)
    }, 0)
    return () => clearTimeout(t)
  }, [lead.id, lead.name])

  useEffect(() => {
    if (isEditingName) {
      nameInputRef.current?.focus()
      nameInputRef.current?.select()
    }
  }, [isEditingName])

  // Preserva exatamente a mensagem que estava no topo quando um lote antigo
  // é prependado. useLayoutEffect roda depois do DOM novo e antes do paint,
  // evitando salto visual e uma segunda paginação disparada pelo scrollTop=0.
  useLayoutEffect(() => {
    const previousHeight = prependScrollHeightRef.current
    const container = messagesContainerRef.current
    if (previousHeight == null || !container) return
    container.scrollTop += container.scrollHeight - previousHeight
    prependScrollHeightRef.current = null
  }, [messages])

  useEffect(() => {
    const firstRefresh = setTimeout(() => refresh(true), 0)
    const t = setInterval(() => refresh(true), ACTIVE_CHAT_POLL_MS)
    return () => {
      clearTimeout(firstRefresh)
      clearInterval(t)
    }
  }, [refresh])

  const loadOlderMessages = useCallback(async () => {
    if (!historyCursor || !hasMoreHistory || loadingHistoryRef.current) return
    const container = messagesContainerRef.current
    const previousHeight = container?.scrollHeight ?? 0
    loadingHistoryRef.current = true
    setLoadingHistory(true)
    try {
      const res = await fetch(`/api/inbox/${lead.id}?before=${encodeURIComponent(historyCursor)}`, { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      const older = (data.messages || []) as InboxMessage[]
      prependScrollHeightRef.current = previousHeight
      setMessages(prev => {
        const merged = new Map(older.map(message => [message.id, message]))
        for (const message of prev) merged.set(message.id, message)
        return [...merged.values()].sort((a, b) => {
          const timeDiff = new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
          return timeDiff || a.id - b.id
        })
      })
      setHasMoreHistory(Boolean(data.history?.hasMore))
      setHistoryCursor(data.history?.nextCursor ?? null)
    } finally {
      loadingHistoryRef.current = false
      setLoadingHistory(false)
    }
  }, [hasMoreHistory, historyCursor, lead.id])

  const handleMessagesScroll = useCallback(() => {
    const container = messagesContainerRef.current
    if (
      didInitialScrollRef.current
      && container
      && container.scrollHeight > container.clientHeight
      && container.scrollTop < 120
    ) loadOlderMessages()
  }, [loadOlderMessages])

  const [sendError, setSendError] = useState<string | null>(null)

  async function handleToggleBotPause() {
    if (pauseLoading) return
    setPauseLoading(true)
    const nextState = !botPaused
    try {
      const res = await fetch(`/api/inbox/${lead.id}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: nextState }),
      })
      if (res.ok) {
        const data = await res.json()
        setBotPaused(data.botPaused)
        setPauseToast(
          data.botPaused
            ? '⏸️ Bot pausado! O atendimento foi assumido por operador humano.'
            : '🟢 Bot retomado! O assistente virtual voltará a responder automaticamente.'
        )
        setTimeout(() => setPauseToast(null), 4000)
      } else {
        const errData = await res.json().catch(() => ({}))
        setPauseToast(`❌ ${errData.error || 'Não foi possível alterar a pausa do bot.'}`)
        setTimeout(() => setPauseToast(null), 4000)
      }
    } catch {
      setPauseToast('❌ Erro de conexão ao alterar pausa do bot.')
      setTimeout(() => setPauseToast(null), 4000)
    } finally {
      setPauseLoading(false)
    }
  }

  function startEditingName() {
    if (savingName) return
    setEditingName(leadName ?? '')
    setNameError(null)
    setIsEditingName(true)
  }

  function cancelEditingName() {
    setEditingName(leadName ?? '')
    setIsEditingName(false)
    setNameError(null)
  }

  async function saveLeadName() {
    if (savingName) return
    const nextName = editingName.trim()
    const previousName = leadName

    if (!nextName) {
      setEditingName(previousName ?? '')
      setIsEditingName(false)
      setNameError('Nome obrigatório')
      return
    }

    if (nextName === (previousName ?? '').trim()) {
      setIsEditingName(false)
      setNameError(null)
      return
    }

    setLeadName(nextName)
    setIsEditingName(false)
    setNameError(null)
    setSavingName(true)

    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nextName }),
      })

      if (!res.ok) throw new Error('Falha ao salvar o nome')
      const data = await res.json()
      setLeadName(data.lead?.name ?? nextName)
    } catch {
      setLeadName(previousName)
      setEditingName(previousName ?? '')
      setNameError('Não foi possível salvar')
    } finally {
      setSavingName(false)
    }
  }

  async function handleSend() {
    if (!text.trim() || sending) return
    setSending(true)
    setSendError(null)
    const content = text.trim()
    try {
      const res = await fetch(`/api/inbox/${lead.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      if (res.ok) {
        const msg: InboxMessage = await res.json()
        setText('')
        shouldScrollToBottomRef.current = true
        setMessages(prev => [...prev, msg])
      } else {
        const errData = await res.json().catch(() => ({}))
        setSendError(errData.error || 'Falha ao enviar mensagem. Seu rascunho foi mantido.')
      }
    } catch {
      setSendError('Erro de conexão ao enviar mensagem. Seu rascunho foi mantido.')
    } finally {
      setSending(false)
    }
  }

  function handleComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function handleNameKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveLeadName()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEditingName()
    }
  }

  const displayName = leadName || lead.phone
  const initials = displayName.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase()
  // Fallback genérico preservado quando a empresa ainda não tem nome de
  // agente resolvido (companies.agentDisplayName nulo), pra nunca quebrar a
  // tela por falta desse dado.
  const agentLabel = lead.agentDisplayName?.trim() || 'Bot IA'

  const channelLabel =
    lead.channel === 'instagram' || lead.phone.startsWith('ig_')
      ? 'Instagram Direct'
      : lead.channel === 'email'
        ? 'E-mail'
        : lead.channel === 'mineracao'
          ? 'Mineração'
          : 'WhatsApp'

  return (
    <div className="flex flex-1 h-full w-full overflow-hidden bg-surface-base relative">
      {/* Coluna Principal do Chat */}
      <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden">
        {/* Toast Notificação de Pausa do Bot */}
        {pauseToast && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 bg-surface-panel border border-brand-solid/30 text-fg px-4 py-2 rounded-xl shadow-lg flex items-center gap-2 text-micro font-medium animate-in fade-in slide-in-from-top-2">
            <Sparkles size={14} className="text-brand-ink" />
            <span>{pauseToast}</span>
          </div>
        )}

        {/* 1. Cabeçalho do Atendimento */}
        <div className="flex items-center justify-between gap-3 border-b border-line-subtle bg-surface-panel px-3.5 py-2.5 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <Link
              href={backHref}
              aria-label="Voltar para conversas"
              className="focus-ring md:hidden flex items-center justify-center h-9 w-9 shrink-0 rounded-lg text-fg-muted transition-colors hover:text-fg hover:bg-surface-inset"
            >
              <ArrowLeft size={18} />
            </Link>

            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-inset border border-line-subtle text-micro font-bold text-fg-muted shrink-0">
              {initials}
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                {isEditingName ? (
                  <input
                    ref={nameInputRef}
                    value={editingName}
                    onChange={e => setEditingName(e.target.value)}
                    onBlur={saveLeadName}
                    onKeyDown={handleNameKeyDown}
                    disabled={savingName}
                    aria-label="Nome do lead"
                    className="focus-ring min-w-0 max-w-[220px] rounded-md border border-line-subtle bg-surface-inset px-1.5 py-0.5 text-body font-bold leading-tight text-fg outline-none disabled:opacity-60"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={startEditingName}
                    disabled={savingName}
                    title="Editar nome"
                    className="group inline-flex min-w-0 max-w-[220px] items-center gap-1 text-left text-body font-bold leading-tight text-fg disabled:opacity-60"
                  >
                    <span className="truncate">{displayName}</span>
                    {savingName ? (
                      <Loader2 size={12} className="shrink-0 animate-spin text-fg-subtle" />
                    ) : (
                      <Pencil size={12} className="shrink-0 text-fg-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                    )}
                  </button>
                )}
                <ChannelBadge channel={lead.channel} />
                <PlatformBadge platform={lead.platform || lead.trackingSource} eventType={lead.eventType} />
                <EmailEngagementBadge engagement={lead.emailEngagement} />
              </div>
              {nameError && (
                <p className="mt-0.5 text-[10px] font-medium text-red-500">
                  {nameError}
                </p>
              )}
              <p className="truncate text-[11px] text-fg-subtle font-mono mt-0.5">
                {lead.phone}
                {lead.productName ? <span className="text-fg-muted font-sans font-medium"> · {lead.productName}</span> : null}
              </p>
            </div>
          </div>

          {/* Ações do Topo: Botão Pausar/Retomar Bot, Info Lead e Refresh */}
          <div className="flex items-center gap-2 shrink-0">
            {/* BOTÃO PAUSAR / RETOMAR BOT */}
            <button
              type="button"
              onClick={handleToggleBotPause}
              disabled={pauseLoading}
              title={botPaused ? 'Clique para retomar o robô de IA' : 'Clique para pausar o robô e assumir o atendimento manual'}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-[11px] font-bold transition-all cursor-pointer shadow-2xs select-none disabled:opacity-50',
                botPaused
                  ? 'border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25'
                  : 'border-emerald-500/40 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/25'
              )}
            >
              {pauseLoading ? (
                <Loader2 size={13} className="animate-spin" />
              ) : botPaused ? (
                <Play size={13} className="fill-current" />
              ) : (
                <Pause size={13} className="fill-current" />
              )}
              <span>{botPaused ? 'Retomar Bot' : 'Pausar Bot'}</span>
            </button>

            {/* Alternador de Detalhes do Lead */}
            <button
              type="button"
              onClick={() => setShowDetails(prev => !prev)}
              title="Ver detalhes do lead"
              className={cn(
                'h-8 w-8 flex items-center justify-center rounded-xl border text-fg-subtle transition-colors hover:text-fg cursor-pointer',
                showDetails
                  ? 'border-brand-solid/40 bg-surface-raised text-brand-ink'
                  : 'border-line-subtle bg-surface-inset hover:bg-surface-raised'
              )}
            >
              <Info size={15} />
            </button>

            {/* Botão de Atualizar */}
            <button
              onClick={() => refresh(false)}
              disabled={refreshing}
              aria-label="Atualizar mensagens"
              title="Atualizar mensagens"
              className="h-8 w-8 flex items-center justify-center rounded-xl border border-line-subtle bg-surface-inset text-fg-subtle transition-colors hover:text-fg hover:bg-surface-raised disabled:opacity-40 cursor-pointer"
            >
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* 1.1 Banner da Janela Oficial da Meta (24h / 72h) */}
        <MetaWindowBanner lead={lead} />

        {/* 2. Área de Mensagens */}
        <div
          ref={messagesContainerRef}
          onScroll={handleMessagesScroll}
          className="scroll-thin flex-1 overflow-y-auto bg-surface-base px-4 py-4 min-h-0"
        >
          {(hasMoreHistory || loadingHistory) && (
            <div className="flex justify-center pb-3">
              <button
                type="button"
                onClick={loadOlderMessages}
                disabled={loadingHistory}
                className="inline-flex items-center gap-1.5 rounded-full border border-line-subtle bg-surface-panel px-3 py-1.5 text-[11px] font-semibold text-fg-muted shadow-xs hover:text-fg disabled:opacity-60"
              >
                {loadingHistory ? <Loader2 size={12} className="animate-spin" /> : <ChevronUp size={12} />}
                {loadingHistory ? 'Carregando…' : 'Carregar mensagens anteriores'}
              </button>
            </div>
          )}
          <MessageList messages={messages} contactName={leadName} agentName={agentLabel} />
        </div>

        {/* 3. Área de Envio da Mensagem */}
        <div className="border-t border-line-subtle bg-surface-panel p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:pb-3 shrink-0 space-y-2">
          {sendError && (
            <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 text-micro flex items-center justify-between">
              <span>⚠️ {sendError}</span>
              <button onClick={() => setSendError(null)} className="text-fg-subtle hover:text-fg font-bold">×</button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={`Responder ${displayName} via ${channelLabel}... (Enter para enviar, Shift+Enter para quebra de linha)`}
              rows={1}
              className="focus-ring flex-1 resize-none rounded-xl border border-line-subtle bg-surface-inset px-4 py-2.5 text-body text-fg placeholder:text-fg-subtle outline-none max-h-32 overflow-y-auto scroll-thin leading-relaxed"
              style={{ minHeight: 44 }}
            />
            <button
              onClick={handleSend}
              disabled={!text.trim() || sending}
              aria-label="Enviar mensagem"
              title={`Enviar mensagem via ${channelLabel}`}
              className="focus-ring flex items-center justify-center h-11 w-11 shrink-0 rounded-xl bg-brand-solid text-on-accent transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shadow-xs"
            >
              {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>

          <div className="flex items-center justify-between text-micro text-fg-faint mt-2 px-1">
            <span className="flex items-center gap-1.5">
              <ChannelIcon channel={lead.channel} size={12} />
              <span>Canal: <strong className="text-fg font-semibold">{channelLabel}</strong></span>
            </span>

            <span className="flex items-center gap-1 font-mono">
              {botPaused ? (
                <span className="text-amber-500 font-semibold flex items-center gap-1">
                  <UserCog size={12} /> Intervenção Humana Ativa
                </span>
              ) : (
                <span className="text-emerald-500 font-semibold flex items-center gap-1">
                  <Bot size={12} /> {agentLabel} Monitorando
                </span>
              )}
            </span>
          </div>
        </div>
      </div>

      {/* Painel Lateral com Detalhes do Lead (Gaveta / Aside) */}
      {showDetails && (
        <aside className="w-80 shrink-0 border-l border-line-subtle bg-surface-panel p-4 overflow-y-auto scroll-thin flex flex-col gap-4 animate-in slide-in-from-right duration-200">
          <div className="flex items-center justify-between pb-2 border-b border-line-subtle">
            <h3 className="text-body font-bold text-fg">Detalhes do Contato</h3>
            <button
              onClick={() => setShowDetails(false)}
              className="text-fg-subtle hover:text-fg p-1 rounded-lg hover:bg-surface-inset"
            >
              <X size={16} />
            </button>
          </div>

          {/* Status do Atendimento & Bot */}
          <div className="rounded-xl border border-line-subtle bg-surface-inset p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-micro font-bold uppercase text-fg-subtle">Status Bot:</span>
              <BotStatusPill paused={botPaused} agentName={agentLabel} />
            </div>
            {lead.botPausedAt && (
              <p className="text-[10px] text-fg-faint font-mono">
                Pausado em: {new Date(lead.botPausedAt).toLocaleString('pt-BR')} por {lead.botPausedBy || 'humano'}
              </p>
            )}
          </div>

          {/* Tags do lead (25/09/2026) — a tag "pessoa" pausa o bot, ver LeadTags.tsx */}
          <LeadTags leadId={lead.id} botPaused={botPaused} onBotPausedChange={setBotPaused} />

          {/* Consultas reais espelhadas da agenda nativa do Dr. Lucas */}
          {appointments.length > 0 && (
            <div className="space-y-2">
              <h4 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-fg-subtle">
                <CalendarDays size={13} /> Consultas
              </h4>
              <div className="rounded-xl border border-line-subtle bg-surface-inset divide-y divide-line-subtle">
                {appointments.map(appointment => {
                  const cancelled = Boolean(appointment.cancelledAt) || appointment.status.toLowerCase().includes('cancel')
                  return (
                    <div key={appointment.nativeId} className="p-3 space-y-1.5 text-micro">
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-fg font-semibold">
                          {new Date(appointment.consultationAt).toLocaleString('pt-BR', {
                            timeZone: 'America/Sao_Paulo',
                            dateStyle: 'short',
                            timeStyle: 'short',
                          })}
                        </span>
                        <span className={cn(
                          'rounded-full border px-2 py-0.5 text-[10px] font-bold capitalize',
                          cancelled
                            ? 'border-red-500/30 bg-red-500/10 text-red-500'
                            : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500'
                        )}>
                          {appointment.status}
                        </span>
                      </div>
                      {appointment.origin && <p className="text-fg-faint">Origem: {appointment.origin.replace(/_/g, ' ')}</p>}
                      {appointment.cancelledAt && (
                        <p className="text-red-500">
                          Cancelada em {new Date(appointment.cancelledAt).toLocaleString('pt-BR', {
                            timeZone: 'America/Sao_Paulo',
                            dateStyle: 'short',
                            timeStyle: 'short',
                          })}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Janela de Atendimento Meta Cloud API */}
          {(() => {
            const win = getMetaWindowInfo(lead)
            return (
              <div className="rounded-xl border border-line-subtle bg-surface-inset p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-micro font-bold uppercase text-fg-subtle">Janela Meta API:</span>
                  <span
                    className={cn(
                      'text-[10px] font-bold px-2 py-0.5 rounded-full border',
                      win.badgeClass
                    )}
                  >
                    {win.typeLabel}
                  </span>
                </div>
                <div className="text-micro space-y-1">
                  <div className="flex justify-between">
                    <span className="text-fg-faint">Status:</span>
                    <span className="text-fg font-semibold">
                      {win.status === 'active'
                        ? `Aberta (${win.remainingHours}h ${win.remainingMinutes}m restantes)`
                        : win.status === 'expiring_soon'
                        ? `Expirando (${win.remainingHours}h ${win.remainingMinutes}m)`
                        : win.status === 'expired'
                        ? 'Expirada (Requer Template)'
                        : 'Aguardando resposta'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-fg-faint">Regra da Janela:</span>
                    <span className="text-fg-muted font-mono text-[10px]">
                      {win.isAd ? '72h para Anúncios (CTWA)' : '24h Atendimento Padrão'}
                    </span>
                  </div>
                  {lead.lastInboundAt && (
                    <div className="flex justify-between">
                      <span className="text-fg-faint">Última msg do lead:</span>
                      <span className="text-fg-muted font-mono text-[10px]">
                        {new Date(lead.lastInboundAt).toLocaleString('pt-BR')}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )
          })()}

          {/* Informações de Compra & Produto */}
          {(lead.agentConversationId || lead.agentCostUsd || lead.agentInputTokens != null || lead.agentOutputTokens != null || lead.agentSyncedAt) && (
            <div className="space-y-2">
              <h4 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-fg-subtle">
                <Database size={12} /> Auditoria IA
              </h4>
              <div className="rounded-xl border border-line-subtle bg-surface-inset p-3 space-y-2 text-micro">
                <div className="flex justify-between gap-3">
                  <span className="text-fg-faint">Custo estimado:</span>
                  <span className="font-mono text-fg">{lead.agentCostUsd ? `US$ ${Number(lead.agentCostUsd).toFixed(6)}` : '—'}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-fg-faint">Tokens entrada:</span>
                  <span className="font-mono text-fg">{lead.agentInputTokens?.toLocaleString('pt-BR') ?? '—'}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-fg-faint">Tokens saída:</span>
                  <span className="font-mono text-fg">{lead.agentOutputTokens?.toLocaleString('pt-BR') ?? '—'}</span>
                </div>
                {lead.agentSyncedAt && (
                  <div className="border-t border-line-subtle pt-2">
                    <span className="text-fg-faint block uppercase text-[9px]">Sincronizado:</span>
                    <span className="font-mono text-[10px] text-fg-muted">{new Date(lead.agentSyncedAt).toLocaleString('pt-BR')}</span>
                  </div>
                )}
                {lead.agentConversationId && (
                  <div>
                    <span className="text-fg-faint block uppercase text-[9px]">Sessão Hermes:</span>
                    <span className="block truncate font-mono text-[10px] text-fg-muted" title={lead.agentConversationId}>{lead.agentConversationId}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {lead.reservation && (() => {
            const isCancelled = lead.reservation.status.toLocaleLowerCase('pt-BR').includes('cancel')
            const statusLabel = isCancelled ? 'Cancelada' : lead.reservation.status.replace(/_/g, ' ')
            const value = lead.reservation.totalValue == null
              ? 'Não informado'
              : Number(lead.reservation.totalValue).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
            const date = new Date(`${lead.reservation.date}T12:00:00`).toLocaleDateString('pt-BR')
            const time = lead.reservation.reservedTime?.slice(0, 5) || 'Não informado'
            return (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-fg-subtle">Reserva real</h4>
                  <span className={cn(
                    'text-[10px] font-bold px-2 py-0.5 rounded-full border capitalize',
                    isCancelled
                      ? 'bg-red-500/10 text-red-500 border-red-500/30'
                      : 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'
                  )}>
                    {statusLabel}
                  </span>
                </div>
                <div className="rounded-xl border border-line-subtle bg-surface-inset p-3 grid grid-cols-2 gap-3 text-micro">
                  <div>
                    <span className="text-fg-faint block uppercase text-[9px]">Data</span>
                    <span className="text-fg font-semibold">{date}</span>
                  </div>
                  <div>
                    <span className="text-fg-faint block uppercase text-[9px]">Horário</span>
                    <span className="text-fg font-semibold">{time}</span>
                  </div>
                  <div>
                    <span className="text-fg-faint block uppercase text-[9px]">Pessoas</span>
                    <span className="text-fg font-semibold">{lead.reservation.people ?? 'Não informado'}</span>
                  </div>
                  <div>
                    <span className="text-fg-faint block uppercase text-[9px]">Valor</span>
                    <span className="text-brand-ink font-bold font-mono">{value}</span>
                  </div>
                  {lead.reservation.notes && (
                    <div className="col-span-2">
                      <span className="text-fg-faint block uppercase text-[9px]">Observações</span>
                      <span className="text-fg whitespace-pre-wrap">{lead.reservation.notes}</span>
                    </div>
                  )}
                </div>
              </div>
            )
          })()}

          <div className="space-y-2">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-fg-subtle">CRM & Venda</h4>
            <div className="rounded-xl border border-line-subtle bg-surface-inset p-3 space-y-2 text-micro">
              <div>
                <span className="text-fg-faint block uppercase text-[9px]">Empresa:</span>
                <span className="text-fg font-semibold">{lead.company || '—'}</span>
              </div>
              <div>
                <span className="text-fg-faint block uppercase text-[9px]">Produto:</span>
                <span className="text-fg font-semibold">{lead.productName || 'Não especificado'}</span>
              </div>
              <div>
                <span className="text-fg-faint block uppercase text-[9px]">Valor:</span>
                <span className="text-brand-ink font-bold font-mono">{formatBRL(lead.productValue)}</span>
              </div>
              <div>
                <span className="text-fg-faint block uppercase text-[9px]">Evento de Origem:</span>
                <span className="text-fg capitalize">{lead.eventType?.replace(/_/g, ' ') || 'SAC'}</span>
              </div>
              <div>
                <span className="text-fg-faint block uppercase text-[9px]">Plataforma:</span>
                <span className="text-fg capitalize">{lead.platform || 'Checkout'}</span>
              </div>
              <div>
                <span className="text-fg-faint block uppercase text-[9px]">Primeiro contato:</span>
                <span className="text-fg">
                  {lead.firstContactAt ? new Date(lead.firstContactAt).toLocaleString('pt-BR') : '—'}
                </span>
              </div>
              <div>
                <span className="text-fg-faint block uppercase text-[9px]">Observações:</span>
                <p className="text-fg whitespace-pre-wrap break-words">{lead.notes || '—'}</p>
              </div>
            </div>
          </div>

          {/* Dados de Contato */}
          <div className="space-y-2">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-fg-subtle">Contato & Canal</h4>
            <div className="rounded-xl border border-line-subtle bg-surface-inset p-3 space-y-2 text-micro">
              <div>
                <span className="text-fg-faint block uppercase text-[9px]">Telefone / Handle:</span>
                <span className="text-fg font-mono">{lead.phone}</span>
              </div>
              <div>
                <span className="text-fg-faint block uppercase text-[9px]">E-mail:</span>
                <span className="text-fg font-mono truncate block">{lead.email || '—'}</span>
              </div>
              <div>
                <span className="text-fg-faint block uppercase text-[9px]">Canal Preferencial:</span>
                <span className="text-fg capitalize">{channelLabel}</span>
              </div>
              {lead.phone && !lead.phone.startsWith('ig_') && (
                <div className="pt-1">
                  <a
                    href={`https://wa.me/${lead.phone.replace(/\D/g, '')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-500 hover:underline"
                  >
                    Abrir no WhatsApp Web <ExternalLink size={12} />
                  </a>
                </div>
              )}
            </div>
          </div>

          {/* Rastreamento & UTMs */}
          {(lead.trackingSource || lead.utmCampaign || lead.adsetName || lead.adName) && (
            <div className="space-y-2">
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-fg-subtle">Rastreamento UTM</h4>
              <div className="rounded-xl border border-line-subtle bg-surface-inset p-3 space-y-1.5 text-micro font-mono">
                {lead.trackingSource && (
                  <div>
                    <span className="text-fg-faint text-[9px] block">Source / UTM:</span>
                    <span className="text-fg">{lead.trackingSource}</span>
                  </div>
                )}
                {lead.utmCampaign && (
                  <div>
                    <span className="text-fg-faint text-[9px] block">UTM Campaign:</span>
                    <span className="text-fg">{lead.utmCampaign}</span>
                  </div>
                )}
                {lead.adsetName && (
                  <div>
                    <span className="text-fg-faint text-[9px] block">Conjunto de anúncios:</span>
                    <span className="text-fg">{lead.adsetName}</span>
                  </div>
                )}
                {lead.adName && (
                  <div>
                    <span className="text-fg-faint text-[9px] block">Anúncio:</span>
                    <span className="text-fg">{lead.adName}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </aside>
      )}
    </div>
  )
}
