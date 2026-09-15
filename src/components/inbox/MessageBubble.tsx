'use client'

import { cn } from '@/lib/utils'

export interface InboxMessage {
  id: number
  direction: string
  content: string | null
  messageType: string | null
  mediaUrl: string | null
  sentBy: string | null
  createdAt: string | null
}

/*
  Balão enviado: verde da marca diluído, em vez de verde sólido. Sobre o fundo
  quase preto do chat o sólido brilhava demais e o texto branco vibrava.
*/
const SENT_BUBBLE_STYLE = {
  background: 'color-mix(in oklch, var(--brand-solid) 18%, transparent)',
  borderColor: 'color-mix(in oklch, var(--brand-solid) 30%, transparent)',
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

function sentByLabel(sentBy: string | null) {
  if (sentBy === 'human') return 'Você'
  if (sentBy === 'bot') return 'Bot'
  return 'Sistema'
}

export function MessageBubble({ message }: { message: InboxMessage }) {
  const isInbound = message.direction === 'inbound'

  return (
    <div className={cn('flex flex-col gap-1', isInbound ? 'items-start' : 'items-end')}>
      {/*
        Concatenação simples em vez de cn(): o tailwind-merge trata text-body
        como classe de cor e a descartaria por causa do text-fg.
      */}
      <div
        className={`max-w-[560px] border px-4 py-2.5 text-body leading-relaxed text-fg rounded-[var(--r-lg)] ${
          isInbound
            ? 'bg-surface-raised border-line-subtle rounded-bl-[var(--r-sm)]'
            : 'rounded-br-[var(--r-sm)]'
        }`}
        style={isInbound ? undefined : SENT_BUBBLE_STYLE}
      >
        {message.messageType === 'audio' && message.mediaUrl ? (
          <audio controls preload="none" src={message.mediaUrl} className="h-8 w-52" />
        ) : message.messageType === 'image' && message.mediaUrl ? (
          <div className="space-y-1">
            <img src={message.mediaUrl} alt="imagem" className="rounded-[var(--r-md)] max-w-[240px]" />
            {message.content && <p className="text-micro">{message.content}</p>}
          </div>
        ) : (
          <p className="whitespace-pre-wrap break-words">{message.content || '-'}</p>
        )}
      </div>
      <div className="num flex items-center gap-1.5 px-1 text-micro text-fg-faint">
        {!isInbound && <span>{sentByLabel(message.sentBy)}</span>}
        {message.createdAt && <span>{formatTime(message.createdAt)}</span>}
      </div>
    </div>
  )
}

export function MessageList({ messages }: { messages: InboxMessage[] }) {
  return (
    <div className="flex flex-col gap-3">
      {messages.length === 0 && (
        <p className="text-center text-body text-fg-subtle py-8">Nenhuma mensagem ainda</p>
      )}
      {messages.map((msg, index) => {
        const currentDay = msg.createdAt ? toDateKey(msg.createdAt) : ''
        const prevDay = index > 0 && messages[index - 1].createdAt ? toDateKey(messages[index - 1].createdAt!) : null
        const showSeparator = currentDay !== prevDay

        return (
          <div key={msg.id} className="flex flex-col gap-3">
            {showSeparator && msg.createdAt && (
              <div className="flex items-center justify-center my-1">
                <span className="badge border-line-subtle bg-surface-inset text-fg-subtle">
                  {formatDateSeparator(msg.createdAt)}
                </span>
              </div>
            )}
            <MessageBubble message={msg} />
          </div>
        )
      })}
    </div>
  )
}
