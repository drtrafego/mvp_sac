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
  Zap,
  FileText,
  CheckCircle2,
  Clock,
  AlertCircle,
  Trash2,
  Plus,
  MessageSquare,
  ChevronDown,
  UserCheck,
} from 'lucide-react'
import Link from 'next/link'
import { MessageList, type InboxMessage } from './MessageBubble'
import { LeadTags } from './LeadTags'
import { ChannelIcon, ChannelBadge, PlatformBadge, BotStatusPill, EmailEngagementBadge } from './ChannelBadge'
import { MetaWindowBanner, getMetaWindowInfo } from './MetaWindowBadge'
import { cn } from '@/lib/utils'
import type { EmailEngagement } from '@/lib/email-engagement'

const ACTIVE_CHAT_POLL_MS = 5_000

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
  requestSummary?: string | null
  requestMessageId?: number | null
  commitment?: string | null
  nextAction?: string | null
  humanOwnerMemberId?: number | null
  nextActionDueAt?: string | null
  sacCaseState?: string | null
  pipelineStage?: string | null
  responsibleAgent?: string | null
  followUpDate?: string | null
  followUpNote?: string | null
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
  highlightMessageId,
}: {
  lead: ChatLead
  initialMessages: InboxMessage[]
  appointments?: MirroredAppointment[]
  initialHistory: { hasMore: boolean; nextCursor: string | null }
  backHref?: '/inbox' | '/instagram'
  highlightMessageId?: number | null
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

  // SAC Lote 1: Abas do Painel Lateral
  const [sidePanelTab, setSidePanelTab] = useState<'context' | 'notes' | 'info'>('context')

  // SAC Lote 1: Card de Contexto e Próxima Ação
  const [requestSummary, setRequestSummary] = useState(lead.requestSummary ?? '')
  const [commitment, setCommitment] = useState(lead.commitment ?? '')
  const [nextAction, setNextAction] = useState(lead.nextAction ?? '')
  const [nextActionDueAt, setNextActionDueAt] = useState(lead.nextActionDueAt ? lead.nextActionDueAt.slice(0, 10) : '')
  const [pipelineStage, setPipelineStage] = useState(lead.pipelineStage ?? 'novo_contato')
  const [followUpDate, setFollowUpDate] = useState(lead.followUpDate ? lead.followUpDate.slice(0, 10) : '')
  const [followUpNote, setFollowUpNote] = useState(lead.followUpNote ?? '')
  const [humanOwner, setHumanOwner] = useState<string | number | null>(lead.humanOwnerMemberId ?? null)
  const [isEditingContext, setIsEditingContext] = useState(false)
  const [savingContext, setSavingContext] = useState(false)
  const [claiming, setClaiming] = useState(false)

  // SAC Lote 1: Notas Internas
  const [internalNotes, setInternalNotes] = useState<Array<{ id: number; body: string; authorName: string | null; createdAt: string | null }>>([])
  const [newNoteText, setNewNoteText] = useState('')
  const [loadingNotes, setLoadingNotes] = useState(false)
  const [savingNote, setSavingNote] = useState(false)

  // SAC Lote 1: Respostas Aprovadas
  const [showApprovedReplies, setShowApprovedReplies] = useState(false)
  const [approvedReplies, setApprovedReplies] = useState<Array<{ id: number; title: string; shortcut: string | null; body: string; variables: string[] | null }>>([])
  const [loadingReplies, setLoadingReplies] = useState(false)
  const [replyFilter, setReplyFilter] = useState('')

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const loadingHistoryRef = useRef(false)
  const didInitialScrollRef = useRef(false)
  const shouldScrollToBottomRef = useRef(true)
  const prependScrollHeightRef = useRef<number | null>(null)
  const pendingRequestIdRef = useRef<string | null>(null)

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

  // ── SAC Lote 1: Handlers de Notas Internas ─────────────────────────────────
  const loadNotes = useCallback(async () => {
    setLoadingNotes(true)
    try {
      const res = await fetch(`/api/inbox/${lead.id}/notes`)
      if (res.ok) {
        const data = await res.json()
        setInternalNotes(data.notes || [])
      }
    } catch {
      // silencioso
    } finally {
      setLoadingNotes(false)
    }
  }, [lead.id])

  useEffect(() => {
    if (showDetails && sidePanelTab === 'notes') {
      loadNotes()
    }
  }, [showDetails, sidePanelTab, loadNotes])

  async function handleCreateNote(e: React.FormEvent) {
    e.preventDefault()
    if (!newNoteText.trim() || savingNote) return
    setSavingNote(true)
    try {
      const res = await fetch(`/api/inbox/${lead.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: newNoteText.trim() }),
      })
      if (res.ok) {
        setNewNoteText('')
        await loadNotes()
      }
    } catch {
      // erro
    } finally {
      setSavingNote(false)
    }
  }

  async function handleDeleteNote(noteId: number) {
    try {
      const res = await fetch(`/api/inbox/${lead.id}/notes/${noteId}`, { method: 'DELETE' })
      if (res.ok) {
        setInternalNotes(prev => prev.filter(n => n.id !== noteId))
      }
    } catch {
      // erro
    }
  }

  // ── SAC Lote 1: Handlers de Respostas Aprovadas ────────────────────────────
  const loadReplies = useCallback(async () => {
    setLoadingReplies(true)
    try {
      const res = await fetch('/api/approved-replies')
      if (res.ok) {
        const data = await res.json()
        setApprovedReplies(data.replies || [])
      }
    } catch {
      // silencioso
    } finally {
      setLoadingReplies(false)
    }
  }, [])

  useEffect(() => {
    if (showApprovedReplies) {
      loadReplies()
    }
  }, [showApprovedReplies, loadReplies])

  function handleInsertReply(reply: { id: number; title: string; shortcut: string | null; body: string }) {
    let replacedBody = reply.body
    const nameToUse = leadName || 'cliente'
    replacedBody = replacedBody.replace(/\{nome\}/gi, nameToUse)
    replacedBody = replacedBody.replace(/\{produto\}/gi, lead.productName || 'produto')

    setText(prev => (prev.trim() ? `${prev}\n\n${replacedBody}` : replacedBody))
    setShowApprovedReplies(false)
    textareaRef.current?.focus()
  }

  const filteredReplies = approvedReplies.filter(r => {
    if (!replyFilter.trim()) return true
    const q = replyFilter.toLowerCase()
    return (
      r.title.toLowerCase().includes(q) ||
      (r.shortcut && r.shortcut.toLowerCase().includes(q)) ||
      r.body.toLowerCase().includes(q)
    )
  })

  // ── SAC Lote 1: Handlers de Atendimento Humano & Contexto ──────────────────
  async function handleClaim() {
    setClaiming(true)
    try {
      const res = await fetch(`/api/inbox/${lead.id}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberName: 'Atendente Humano' }),
      })
      if (res.ok) {
        const data = await res.json()
        setBotPaused(true)
        setHumanOwner(data.lead?.humanOwnerMemberId || 'Atendente Humano')
        setPauseToast('Você assumiu este atendimento! O bot foi pausado.')
        setTimeout(() => setPauseToast(null), 3500)
      }
    } catch {
      // erro
    } finally {
      setClaiming(false)
    }
  }

  async function handleSaveContext() {
    setSavingContext(true)
    try {
      const res = await fetch(`/api/inbox/${lead.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestSummary,
          commitment,
          nextAction,
          nextActionDueAt: nextActionDueAt ? new Date(nextActionDueAt).toISOString() : null,
          pipelineStage,
          followUpDate: followUpDate ? new Date(followUpDate).toISOString() : null,
          followUpNote,
        }),
      })
      if (res.ok) {
        setIsEditingContext(false)
        setPauseToast('Contexto atualizado com sucesso!')
        setTimeout(() => setPauseToast(null), 3000)
      }
    } catch {
      // erro
    } finally {
      setSavingContext(false)
    }
  }


  async function handleSend() {
    if (!text.trim() || sending) return
    setSending(true)
    setSendError(null)
    const content = text.trim()
    const clientRequestId =
      pendingRequestIdRef.current ||
      (typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2))
    pendingRequestIdRef.current = clientRequestId

    try {
      const res = await fetch(`/api/inbox/${lead.id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Request-Id': clientRequestId,
        },
        body: JSON.stringify({ content, clientRequestId }),
      })
      if (res.ok) {
        const msg: InboxMessage = await res.json()
        setText('')
        pendingRequestIdRef.current = null
        shouldScrollToBottomRef.current = true
        setMessages(prev => [...prev, msg])
      } else if (res.status === 202) {
        setSendError('Envio aceito para processamento em segundo plano (202). Aguardando confirmação da operadora.')
      } else {
        const errData = await res.json().catch(() => ({}))
        setSendError(errData.error || 'Falha no transporte da operadora. Seu rascunho foi mantido.')
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
            <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 text-micro flex items-center justify-between gap-2">
              <span className="flex-1">⚠️ {sendError}</span>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={sending}
                  className="font-semibold underline hover:text-rose-300 text-micro cursor-pointer disabled:opacity-50"
                >
                  Tentar de novo
                </button>
                <button
                  type="button"
                  onClick={() => setSendError(null)}
                  className="text-fg-subtle hover:text-fg font-bold px-1"
                >
                  ×
                </button>
              </div>
            </div>
          )}
          {/* SAC Lote 1: Atalho para Respostas Aprovadas */}
          <div className="flex items-center justify-between gap-2 px-1">
            <button
              type="button"
              onClick={() => setShowApprovedReplies(prev => !prev)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-line-subtle bg-surface-inset hover:bg-surface-raised text-fg-muted hover:text-fg text-[11px] font-semibold transition-colors cursor-pointer"
            >
              <Zap size={12} className="text-amber-400" />
              <span>Respostas Aprovadas</span>
              <ChevronDown size={11} className={cn("transition-transform", showApprovedReplies && "rotate-180")} />
            </button>
          </div>

          {showApprovedReplies && (
            <div className="rounded-xl border border-line-subtle bg-surface-panel p-3 shadow-xl space-y-2 animate-in fade-in duration-150">
              <div className="flex items-center justify-between pb-1.5 border-b border-line-subtle">
                <span className="text-[11px] font-bold text-fg flex items-center gap-1.5 uppercase tracking-wider">
                  <Zap size={12} className="text-amber-400" />
                  Respostas Aprovadas (SAC)
                </span>
                <button
                  type="button"
                  onClick={() => setShowApprovedReplies(false)}
                  className="text-fg-subtle hover:text-fg p-0.5 rounded cursor-pointer"
                >
                  <X size={14} />
                </button>
              </div>

              <input
                type="text"
                value={replyFilter}
                onChange={e => setReplyFilter(e.target.value)}
                placeholder="Filtrar por título, atalho (/pix) ou texto..."
                className="w-full bg-surface-inset border border-line-subtle rounded-lg px-2.5 py-1.5 text-micro text-fg placeholder:text-fg-faint focus:outline-none focus:border-brand-solid"
              />

              <div className="max-h-48 overflow-y-auto scroll-thin space-y-1 divide-y divide-line-subtle/50">
                {loadingReplies ? (
                  <p className="text-[11px] text-fg-muted p-2 text-center">Carregando respostas...</p>
                ) : filteredReplies.length === 0 ? (
                  <p className="text-[11px] text-fg-muted p-2 text-center">Nenhuma resposta encontrada.</p>
                ) : (
                  filteredReplies.map(reply => (
                    <button
                      key={reply.id}
                      type="button"
                      onClick={() => handleInsertReply(reply)}
                      className="w-full text-left p-2 rounded-lg hover:bg-surface-inset transition-colors flex flex-col gap-0.5 cursor-pointer"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-body font-semibold text-fg text-[12px]">{reply.title}</span>
                        {reply.shortcut && (
                          <span className="text-[10px] font-mono font-bold px-1.5 py-0.2 rounded bg-surface-raised border border-line-subtle text-amber-400">
                            {reply.shortcut}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-fg-muted truncate">{reply.body}</p>
                    </button>
                  ))
                )}
              </div>
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

      {/* Painel Lateral com Contexto SAC, Notas Internas e Detalhes */}
      {showDetails && (
        <aside className="w-84 shrink-0 border-l border-line-subtle bg-surface-panel p-4 overflow-y-auto scroll-thin flex flex-col gap-4 animate-in slide-in-from-right duration-200">
          <div className="flex items-center justify-between pb-2 border-b border-line-subtle">
            <h3 className="text-body font-bold text-fg">Atendimento SAC</h3>
            <button
              onClick={() => setShowDetails(false)}
              className="text-fg-subtle hover:text-fg p-1 rounded-lg hover:bg-surface-inset cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>

          {/* Navegação entre Abas do Painel */}
          <div className="flex items-center border-b border-line-subtle gap-1 pb-1">
            <button
              type="button"
              onClick={() => setSidePanelTab('context')}
              className={cn(
                "flex-1 py-1.5 text-[11px] font-bold rounded-lg transition-colors text-center cursor-pointer",
                sidePanelTab === 'context'
                  ? "bg-surface-raised text-brand-ink border border-brand-solid/30"
                  : "text-fg-subtle hover:text-fg hover:bg-surface-inset"
              )}
            >
              Contexto
            </button>
            <button
              type="button"
              onClick={() => {
                setSidePanelTab('notes')
                loadNotes()
              }}
              className={cn(
                "flex-1 py-1.5 text-[11px] font-bold rounded-lg transition-colors text-center cursor-pointer flex items-center justify-center gap-1",
                sidePanelTab === 'notes'
                  ? "bg-surface-raised text-brand-ink border border-brand-solid/30"
                  : "text-fg-subtle hover:text-fg hover:bg-surface-inset"
              )}
            >
              Notas {internalNotes.length > 0 && <span className="text-[10px] px-1.5 bg-surface-inset rounded-full">{internalNotes.length}</span>}
            </button>
            <button
              type="button"
              onClick={() => setSidePanelTab('info')}
              className={cn(
                "flex-1 py-1.5 text-[11px] font-bold rounded-lg transition-colors text-center cursor-pointer",
                sidePanelTab === 'info'
                  ? "bg-surface-raised text-brand-ink border border-brand-solid/30"
                  : "text-fg-subtle hover:text-fg hover:bg-surface-inset"
              )}
            >
              Detalhes
            </button>
          </div>

          {/* ── ABA 1: CONTEXTO SAC (CARD APROVADO) ─────────────────────────── */}
          {sidePanelTab === 'context' && (
            <div className="space-y-3.5">
              {/* Bloco de Atendimento Humano & Bot */}
              <div className="rounded-xl border border-line-subtle bg-surface-inset p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-micro font-bold uppercase text-fg-subtle">Controle Bot:</span>
                  <BotStatusPill paused={botPaused} agentName={agentLabel} />
                </div>
                {humanOwner ? (
                  <p className="text-[11px] text-amber-500 font-medium flex items-center gap-1">
                    <UserCheck size={12} /> Responsável Humano: {humanOwner}
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={handleClaim}
                    disabled={claiming}
                    className="w-full mt-1 py-1.5 px-3 rounded-lg bg-brand-solid hover:opacity-90 text-on-accent text-micro font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-xs disabled:opacity-50"
                  >
                    {claiming ? <Loader2 size={12} className="animate-spin" /> : <UserCheck size={12} />}
                    Assumir Atendimento
                  </button>
                )}
              </div>

              {/* Card de Contexto e Próxima Ação */}
              <div className="p-3.5 bg-surface-inset border border-line-subtle rounded-xl space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-micro font-bold uppercase text-fg-subtle flex items-center gap-1.5">
                    <FileText size={12} /> Card de Contexto
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (isEditingContext) handleSaveContext()
                      else setIsEditingContext(true)
                    }}
                    disabled={savingContext}
                    className="text-[11px] text-brand-ink font-bold hover:underline cursor-pointer flex items-center gap-1"
                  >
                    {savingContext ? <Loader2 size={11} className="animate-spin" /> : isEditingContext ? <CheckCircle2 size={11} /> : <Pencil size={11} />}
                    {isEditingContext ? 'Salvar' : 'Editar'}
                  </button>
                </div>

                {/* Pedido */}
                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase text-fg-faint block">Pedido do Cliente</label>
                  {isEditingContext ? (
                    <textarea
                      value={requestSummary}
                      onChange={e => setRequestSummary(e.target.value)}
                      placeholder="O que o cliente precisa..."
                      rows={2}
                      className="w-full bg-surface-panel border border-line-subtle rounded-lg p-2 text-micro text-fg focus:outline-none focus:border-brand-solid"
                    />
                  ) : (
                    <p className="text-micro text-fg font-medium bg-surface-panel/60 p-2 rounded-lg border border-line-subtle/50 min-h-[2.5rem]">
                      {requestSummary || <span className="text-fg-faint italic">Nenhum pedido registrado</span>}
                    </p>
                  )}
                  {lead.requestMessageId && (
                    <span className="text-[9px] text-fg-subtle font-mono block">Msg ref: #{lead.requestMessageId}</span>
                  )}
                </div>

                {/* Compromisso */}
                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase text-fg-faint block">Compromisso Acordado</label>
                  {isEditingContext ? (
                    <input
                      type="text"
                      value={commitment}
                      onChange={e => setCommitment(e.target.value)}
                      placeholder="Ex: Enviar orçamento até 16h..."
                      className="w-full bg-surface-panel border border-line-subtle rounded-lg px-2.5 py-1.5 text-micro text-fg focus:outline-none focus:border-brand-solid"
                    />
                  ) : (
                    <p className="text-micro text-fg bg-surface-panel/60 p-2 rounded-lg border border-line-subtle/50">
                      {commitment || <span className="text-fg-faint italic">Sem compromisso registrado</span>}
                    </p>
                  )}
                </div>

                {/* Próxima Ação */}
                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase text-fg-faint block">Próxima Ação</label>
                  {isEditingContext ? (
                    <div className="space-y-1.5">
                      <input
                        type="text"
                        value={nextAction}
                        onChange={e => setNextAction(e.target.value)}
                        placeholder="Ex: Ligar para confirmar..."
                        className="w-full bg-surface-panel border border-line-subtle rounded-lg px-2.5 py-1.5 text-micro text-fg focus:outline-none focus:border-brand-solid"
                      />
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-fg-faint">Prazo:</span>
                        <input
                          type="date"
                          value={nextActionDueAt}
                          onChange={e => setNextActionDueAt(e.target.value)}
                          className="bg-surface-panel border border-line-subtle rounded-lg px-2 py-1 text-micro text-fg focus:outline-none focus:border-brand-solid"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="bg-surface-panel/60 p-2 rounded-lg border border-line-subtle/50 space-y-1">
                      <p className="text-micro text-fg font-medium">
                        {nextAction || <span className="text-fg-faint italic">Nenhuma ação pendente</span>}
                      </p>
                      {nextActionDueAt && (
                        <p className="text-[10px] text-fg-subtle flex items-center gap-1 font-mono">
                          <Clock size={10} /> Prazo: {new Date(nextActionDueAt + 'T12:00:00').toLocaleDateString('pt-BR')}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Etapa Comercial */}
              <div className="p-3 bg-surface-inset border border-line-subtle rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-micro font-bold uppercase text-fg-subtle">Etapa do Pipeline</span>
                  <a
                    href="/pipeline"
                    className="text-[10px] text-brand-ink hover:underline font-semibold flex items-center gap-1"
                  >
                    Ver Funil <ExternalLink size={10} />
                  </a>
                </div>
                <select
                  value={pipelineStage}
                  onChange={async e => {
                    const newStage = e.target.value
                    setPipelineStage(newStage)
                    await fetch(`/api/inbox/${lead.id}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ pipelineStage: newStage }),
                    }).catch(() => null)
                  }}
                  className="w-full bg-surface-panel border border-line-subtle rounded-xl px-3 py-1.5 text-micro text-fg focus:outline-none focus:border-brand-solid cursor-pointer font-medium"
                >
                  <option value="novo_contato">Novo Contato</option>
                  <option value="em_atendimento">Em Atendimento</option>
                  <option value="qualificado">Qualificado</option>
                  <option value="agendado">Agendado / Reserva</option>
                  <option value="compareceu">Compareceu</option>
                  <option value="fechado">Fechado / Ganho</option>
                  <option value="perdido">Perdido</option>
                </select>
              </div>

              {/* Lembrete de Retorno (Follow-up) */}
              <div className="p-3 bg-blue-500/5 border border-blue-500/20 rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-micro font-bold text-blue-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Clock size={12} /> Retorno / Follow-up
                  </span>
                  {followUpDate && (
                    <button
                      type="button"
                      onClick={async () => {
                        setFollowUpDate('')
                        setFollowUpNote('')
                        await fetch(`/api/inbox/${lead.id}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ followUpDate: null, followUpNote: null }),
                        }).catch(() => null)
                      }}
                      className="text-[10px] text-red-400 hover:underline cursor-pointer"
                    >
                      Limpar
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="date"
                    value={followUpDate}
                    onChange={async e => {
                      const v = e.target.value
                      setFollowUpDate(v)
                      await fetch(`/api/inbox/${lead.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ followUpDate: v ? new Date(v).toISOString() : null }),
                      }).catch(() => null)
                    }}
                    className="bg-surface-panel border border-line-subtle rounded-lg px-2 py-1 text-micro text-fg focus:outline-none focus:border-brand-solid"
                  />
                  <input
                    type="text"
                    value={followUpNote}
                    onChange={e => setFollowUpNote(e.target.value)}
                    onBlur={async () => {
                      await fetch(`/api/inbox/${lead.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ followUpNote }),
                      }).catch(() => null)
                    }}
                    placeholder="Motivo..."
                    className="bg-surface-panel border border-line-subtle rounded-lg px-2 py-1 text-micro text-fg focus:outline-none focus:border-brand-solid placeholder:text-fg-faint"
                  />
                </div>
              </div>

              {/* Executor IA */}
              {lead.responsibleAgent && (
                <div className="p-2.5 bg-surface-inset border border-line-subtle rounded-xl flex items-center justify-between text-micro">
                  <span className="text-fg-faint">Executor IA associado:</span>
                  <span className="font-semibold text-fg flex items-center gap-1">
                    <Sparkles size={11} className="text-brand-ink" /> {lead.responsibleAgent}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* ── ABA 2: NOTAS INTERNAS ───────────────────────────────────────── */}
          {sidePanelTab === 'notes' && (
            <div className="space-y-3">
              <div className="p-2 rounded-lg bg-surface-inset border border-line-subtle text-[11px] text-fg-subtle flex items-center gap-1.5">
                <AlertCircle size={13} className="shrink-0 text-amber-400" />
                <span>Notas internas nunca são enviadas ao cliente.</span>
              </div>

              {/* Formulário para adicionar nova nota */}
              <form onSubmit={handleCreateNote} className="space-y-2">
                <textarea
                  value={newNoteText}
                  onChange={e => setNewNoteText(e.target.value)}
                  placeholder="Escreva uma orientação interna para a equipe..."
                  rows={2}
                  className="w-full bg-surface-inset border border-line-subtle rounded-xl p-2.5 text-micro text-fg placeholder:text-fg-faint focus:outline-none focus:border-brand-solid resize-none"
                />
                <button
                  type="submit"
                  disabled={!newNoteText.trim() || savingNote}
                  className="w-full py-1.5 rounded-lg bg-brand-solid text-on-accent text-micro font-bold hover:opacity-90 transition-all disabled:opacity-50 cursor-pointer flex items-center justify-center gap-1"
                >
                  {savingNote ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                  Adicionar Nota
                </button>
              </form>

              {/* Lista de Notas */}
              <div className="space-y-2">
                {loadingNotes ? (
                  <p className="text-[11px] text-fg-muted p-2 text-center">Carregando notas...</p>
                ) : internalNotes.length === 0 ? (
                  <p className="text-[11px] text-fg-muted p-4 text-center border border-dashed border-line-subtle rounded-xl">
                    Nenhuma nota interna registrada.
                  </p>
                ) : (
                  internalNotes.map(n => (
                    <div
                      key={n.id}
                      className="p-2.5 rounded-xl border border-line-subtle bg-surface-inset space-y-1 text-micro relative group"
                    >
                      <div className="flex items-center justify-between text-[10px] text-fg-faint">
                        <span className="font-semibold text-fg-subtle">{n.authorName || 'Equipe'}</span>
                        <div className="flex items-center gap-1.5">
                          <span>{n.createdAt ? new Date(n.createdAt).toLocaleDateString('pt-BR') : ''}</span>
                          <button
                            type="button"
                            onClick={() => handleDeleteNote(n.id)}
                            className="text-fg-faint hover:text-red-400 p-0.5 rounded cursor-pointer opacity-70 hover:opacity-100"
                            title="Excluir nota"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </div>
                      <p className="text-fg whitespace-pre-wrap">{n.body}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* ── ABA 3: INFO & AUDITORIA ─────────────────────────────────────── */}
          {sidePanelTab === 'info' && (
            <div className="space-y-4">
              {/* Tags do lead */}
              <LeadTags leadId={lead.id} botPaused={botPaused} onBotPausedChange={setBotPaused} />

              {/* Consultas reais espelhadas */}
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
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Janela Meta API */}
              {(() => {
                const win = getMetaWindowInfo(lead)
                return (
                  <div className="rounded-xl border border-line-subtle bg-surface-inset p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-micro font-bold uppercase text-fg-subtle">Janela Meta API:</span>
                      <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full border', win.badgeClass)}>
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
                    </div>
                  </div>
                )
              })()}

              {/* CRM & Venda */}
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
                    <span className="text-fg-faint block uppercase text-[9px]">Telefone:</span>
                    <span className="text-fg font-mono">{lead.phone}</span>
                  </div>
                  <div>
                    <span className="text-fg-faint block uppercase text-[9px]">E-mail:</span>
                    <span className="text-fg font-mono truncate block">{lead.email || '—'}</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </aside>
      )}
    </div>
  )
}
