'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
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
  DollarSign,
  Tag,
  Clock,
  Sparkles,
  Bot,
  UserCog,
  CheckCircle2,
} from 'lucide-react'
import Link from 'next/link'
import { MessageList, type InboxMessage } from './MessageBubble'
import { ChannelIcon, ChannelBadge, PlatformBadge, BotStatusPill } from './ChannelBadge'
import { MetaWindowBanner, getMetaWindowInfo } from './MetaWindowBadge'
import { cn } from '@/lib/utils'

export interface ChatLead {
  id: number
  phone: string
  name: string | null
  email: string | null
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
  createdAt: string | null
  lastMessageAt?: string | null
  lastInboundAt?: string | null
  lastOutboundAt?: string | null
}

function formatBRL(centavos: number | null | undefined) {
  if (centavos == null) return 'R$ 0,00'
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function ChatWindow({
  lead,
  initialMessages,
}: {
  lead: ChatLead
  initialMessages: InboxMessage[]
}) {
  const [messages, setMessages] = useState<InboxMessage[]>(initialMessages)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [showDetails, setShowDetails] = useState(false)

  // Controle de Pausa do Bot
  const [botPaused, setBotPaused] = useState(lead.botPaused)
  const [pauseLoading, setPauseLoading] = useState(false)
  const [pauseToast, setPauseToast] = useState<string | null>(null)

  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const refresh = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true)
      try {
        const res = await fetch(`/api/inbox/${lead.id}`)
        if (res.ok) {
          const data = await res.json()
          if (data.messages) setMessages(data.messages)
          if (data.lead && typeof data.lead.botPaused === 'boolean') {
            setBotPaused(data.lead.botPaused)
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
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    const t = setInterval(() => refresh(true), 12_000)
    return () => clearInterval(t)
  }, [refresh])

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
      }
    } catch {
      /* erro silencioso */
    } finally {
      setPauseLoading(false)
    }
  }

  async function handleSend() {
    if (!text.trim() || sending) return
    setSending(true)
    const content = text.trim()
    setText('')
    try {
      const res = await fetch(`/api/inbox/${lead.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      if (res.ok) {
        const msg: InboxMessage = await res.json()
        setMessages(prev => [...prev, msg])
      }
    } catch {
      /* silencioso */
    } finally {
      setSending(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const displayName = lead.name || lead.phone
  const initials = displayName.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase()

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
              href="/inbox"
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
                <span className="truncate text-body font-bold text-fg leading-tight">
                  {displayName}
                </span>
                <ChannelBadge channel={lead.channel} />
                <PlatformBadge platform={lead.platform || lead.trackingSource} eventType={lead.eventType} />
              </div>
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
        <div className="scroll-thin flex-1 overflow-y-auto bg-surface-base px-4 py-4">
          <MessageList messages={messages} contactName={lead.name} />
          <div ref={bottomRef} />
        </div>

        {/* 3. Área de Envio da Mensagem */}
        <div className="border-t border-line-subtle bg-surface-panel p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:pb-3 shrink-0">
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={handleKeyDown}
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
                  <Bot size={12} /> Bot IA Monitorando
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
              <BotStatusPill paused={botPaused} />
            </div>
            {lead.botPausedAt && (
              <p className="text-[10px] text-fg-faint font-mono">
                Pausado em: {new Date(lead.botPausedAt).toLocaleString('pt-BR')} por {lead.botPausedBy || 'humano'}
              </p>
            )}
          </div>

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
          <div className="space-y-2">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-fg-subtle">Produto & Venda</h4>
            <div className="rounded-xl border border-line-subtle bg-surface-inset p-3 space-y-2 text-micro">
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
          {(lead.trackingSource || lead.utmCampaign) && (
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
              </div>
            </div>
          )}
        </aside>
      )}
    </div>
  )
}
