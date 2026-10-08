'use client'

import React from 'react'
import { User, Bot, UserCog, FileText, Volume2, Brain, Mail } from 'lucide-react'
import { cn } from '@/lib/utils'
import { cleanMessage } from '@/lib/clean-content'
import { ChannelIcon } from './ChannelBadge'

export interface InboxMessage {
  id: number
  phone?: string
  channel?: string | null
  direction: string
  content: string | null
  messageType?: string | null
  mediaUrl?: string | null
  sentBy?: string | null
  reasoning?: string | null
  sentEmail?: string | null
  sendState?: string | null
  sendError?: string | null
  clientRequestId?: string | null
  createdAt: string | null
}

function formatTime(dateStr: string) {
  return new Date(dateStr).toLocaleTimeString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function toDateKey(dateStr: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(dateStr))
}

function formatDateSeparator(dateStr: string) {
  const key = toDateKey(dateStr)
  const today = toDateKey(new Date().toISOString())
  const yesterday = toDateKey(new Date(Date.now() - 86_400_000).toISOString())
  if (key === today) return 'Hoje'
  if (key === yesterday) return 'Ontem'
  return new Date(dateStr).toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  })
}

export function MessageBubble({
  message,
  contactName,
  agentName,
}: {
  message: InboxMessage
  contactName?: string | null
  // Nome real do agente (ex.: "Clara"), vindo de companies.agentDisplayName.
  // Sem isso, cai no genérico "Bot IA" de sempre (nunca quebra a tela).
  agentName?: string | null
}) {
  const isInbound = message.direction === 'inbound'
  const isBot = message.sentBy === 'bot' || message.sentBy === 'system'
  const isHuman = message.sentBy === 'human'

  // Limpa o conteúdo (transcrições de voz, payloads de e-mail e extrai mídias)
  const { text, media } = cleanMessage(
    message.content,
    isInbound ? 'user' : 'assistant',
    message.channel
  )

  const senderLabel = isInbound
    ? contactName || 'Cliente'
    : isBot
      ? agentName?.trim() || 'Bot IA'
      : 'Atendente Humano'

  return (
    <div
      className={cn(
        'flex items-end gap-2.5 my-1 group',
        isInbound ? 'justify-start' : 'flex-row-reverse justify-start'
      )}
    >
      {/* Avatar do emissor */}
      <div
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-full text-xs font-bold select-none',
          isInbound
            ? 'bg-surface-raised border border-line-subtle text-fg-muted'
            : isHuman
              ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400'
              : 'bg-brand-solid text-on-accent'
        )}
        title={senderLabel}
      >
        {isInbound ? (
          <User className="size-3.5" />
        ) : isHuman ? (
          <UserCog className="size-3.5" />
        ) : (
          <Bot className="size-3.5" />
        )}
      </div>

      {/* Bolha de mensagem */}
      <div
        className={cn(
          'min-w-0 max-w-[85%] md:max-w-[70%] rounded-2xl px-4 py-2.5 text-body leading-relaxed shadow-xs transition-colors',
          isInbound
            ? 'rounded-bl-xs bg-surface-raised border border-line-subtle text-fg'
            : isHuman
              ? 'rounded-br-xs bg-emerald-500/10 dark:bg-emerald-950/40 border border-emerald-500/30 text-fg'
              : 'rounded-br-xs bg-brand-solid/10 border border-brand-solid/30 text-fg'
        )}
      >
        {/* Rótulo do emissor e canal */}
        <div className="flex items-center justify-between gap-2 mb-1">
          <span
            className={cn(
              'text-[10px] uppercase font-bold tracking-wider',
              isInbound
                ? 'text-fg-subtle'
                : isHuman
                  ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                  : 'text-brand-ink font-semibold'
            )}
          >
            {senderLabel}
          </span>
          <span className="flex items-center gap-1 text-[10px] text-fg-faint">
            <ChannelIcon channel={message.channel} size={11} />
            {message.createdAt && <span>{formatTime(message.createdAt)}</span>}
          </span>
        </div>

        {/* Áudio / Mídia Nativa */}
        {(message.messageType === 'audio' || media.some(m => m.kind === 'audio')) && (
          <div className="my-2 bg-surface-base border border-line-subtle rounded-xl p-2 flex items-center gap-2">
            <Volume2 className="size-4 text-brand-ink shrink-0" />
            <audio
              controls
              preload="none"
              src={message.mediaUrl || media.find(m => m.kind === 'audio')?.file}
              className="h-7 w-52 max-w-full"
            />
          </div>
        )}

        {/* Imagem */}
        {(message.messageType === 'image' || media.some(m => m.kind === 'image')) && (
          <div className="my-1.5 space-y-1">
            <img
              src={message.mediaUrl || media.find(m => m.kind === 'image')?.file}
              alt="Mídia da conversa"
              className="rounded-xl border border-line-subtle max-w-[280px] max-h-[300px] object-cover"
            />
          </div>
        )}

        {/* Documento */}
        {(message.messageType === 'document' || media.some(m => m.kind === 'document')) && (
          <a
            href={message.mediaUrl || media.find(m => m.kind === 'document')?.file}
            target="_blank"
            rel="noopener noreferrer"
            className="my-1.5 inline-flex items-center gap-2 rounded-xl border border-line-subtle bg-surface-base px-3 py-2 text-micro text-fg hover:border-brand-solid/50 transition-colors"
          >
            <FileText className="size-4 text-fg-subtle shrink-0" />
            <span className="truncate max-w-[200px]">Documento Anexo</span>
          </a>
        )}

        {/* Texto da Mensagem */}
        {text ? (
          <p className="whitespace-pre-wrap break-words text-[0.875rem] leading-relaxed select-text">
            {text}
          </p>
        ) : !message.mediaUrl && media.length === 0 ? (
          <p className="text-fg-faint italic text-micro flex items-center gap-1">
            {message.messageType === 'sticker'
              ? '🏷️ [Figurinha]'
              : message.messageType === 'audio'
              ? '🎵 [Áudio recebido]'
              : message.messageType === 'image'
              ? '🖼️ [Imagem recebida]'
              : message.messageType === 'document'
              ? '📄 [Documento recebido]'
              : message.messageType === 'location'
              ? '📍 [Localização compartilhada]'
              : message.messageType === 'reaction'
              ? '👍 [Reação]'
              : '💬 [Mensagem sem texto]'}
          </p>
        ) : null}

        {message.sendState === 'failed' && (
          <div className="mt-1.5 flex items-center gap-1 text-[11px] text-rose-400 font-medium bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20">
            <span>⚠️ Falha no transporte</span>
            {message.sendError && <span className="truncate max-w-[200px]" title={message.sendError}>({message.sendError})</span>}
          </div>
        )}
        {message.sendState === 'uncertain' && (
          <div className="mt-1.5 flex items-center gap-1 text-[11px] text-amber-400 font-medium bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
            <span>⚠️ Envio incerto (timeout)</span>
          </div>
        )}
        {message.sendState === 'pending' && (
          <div className="mt-1 flex items-center gap-1 text-[10px] text-amber-400 font-medium">
            <span>⏳ Envio em processamento...</span>
          </div>
        )}

        {(message.reasoning || message.sentEmail) && (
          <details className="mt-2 border-t border-line-subtle/70 pt-1.5 text-[11px]">
            <summary className="cursor-pointer select-none text-fg-faint hover:text-fg-subtle">
              Detalhes técnicos
            </summary>
            <div className="mt-2 space-y-2">
              {message.reasoning && (
                <div className="rounded-lg bg-surface-base/70 p-2">
                  <span className="mb-1 flex items-center gap-1 font-bold uppercase tracking-wide text-fg-subtle">
                    <Brain className="size-3" /> Raciocínio
                  </span>
                  <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-fg-muted scroll-thin">
                    {message.reasoning}
                  </p>
                </div>
              )}
              {message.sentEmail && (
                <div className="rounded-lg bg-surface-base/70 p-2">
                  <span className="mb-1 flex items-center gap-1 font-bold uppercase tracking-wide text-fg-subtle">
                    <Mail className="size-3" /> E-mail enviado
                  </span>
                  <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-fg-muted scroll-thin">
                    {message.sentEmail}
                  </p>
                </div>
              )}
            </div>
          </details>
        )}
      </div>
    </div>
  )
}

export function MessageList({
  messages,
  contactName,
  agentName,
  highlightMessageId,
}: {
  messages: InboxMessage[]
  contactName?: string | null
  agentName?: string | null
  highlightMessageId?: number | null
}) {
  return (
    <div className="flex flex-col gap-2">
      {messages.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-fg-faint">
          <p className="text-body font-medium">Nenhuma mensagem registrada nesta conversa.</p>
          <p className="text-micro text-fg-subtle">
            Envie uma mensagem abaixo para iniciar o atendimento pelo canal conectado.
          </p>
        </div>
      )}
      {messages.map((msg, index) => {
        const currentDay = msg.createdAt ? toDateKey(msg.createdAt) : ''
        const prevDay =
          index > 0 && messages[index - 1].createdAt
            ? toDateKey(messages[index - 1].createdAt!)
            : null
        const showSeparator = currentDay !== prevDay

        return (
          <React.Fragment key={msg.id || index}>
            {showSeparator && msg.createdAt && (
              <div className="flex items-center justify-center my-3">
                <span className="badge border-line-subtle bg-surface-inset text-fg-subtle text-[11px] font-semibold px-3 py-1">
                  {formatDateSeparator(msg.createdAt)}
                </span>
              </div>
            )}
            <div data-message-id={msg.id} className={cn(msg.id === highlightMessageId && 'rounded-xl ring-2 ring-brand-solid/60 bg-brand-glow p-2')}>
              {msg.id === highlightMessageId && <p className="mb-1 text-[11px] font-semibold text-brand-ink">Mensagem de referência</p>}
              <MessageBubble message={msg} contactName={contactName} agentName={agentName} />
            </div>
          </React.Fragment>
        )
      })}
    </div>
  )
}
