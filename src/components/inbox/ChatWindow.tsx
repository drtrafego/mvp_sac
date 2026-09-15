'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { ArrowLeft, RefreshCw, Send } from 'lucide-react'
import Link from 'next/link'
import { MessageList, type InboxMessage } from './MessageBubble'

interface Lead {
  id: number
  phone: string
  name: string | null
  eventType: string
  status: string | null
  productName: string | null
}

const eventLabels: Record<string, string> = {
  boleto: 'Boleto',
  pix: 'Pix',
  carrinho_abandonado: 'Carrinho Abandonado',
  cartao_recusado: 'Cartão Recusado',
  compra_aprovada: 'Compra Aprovada',
}

export function ChatWindow({ lead, initialMessages }: { lead: Lead; initialMessages: InboxMessage[] }) {
  const [messages, setMessages] = useState(initialMessages)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true)
    try {
      const res = await fetch(`/api/inbox/${lead.id}`)
      if (res.ok) setMessages(await res.json())
    } catch { /* silencioso */ }
    finally { if (!silent) setRefreshing(false) }
  }, [lead.id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    const t = setInterval(() => refresh(true), 15_000)
    return () => clearInterval(t)
  }, [refresh])

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
    } catch { /* silencioso */ }
    finally { setSending(false) }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const displayName = lead.name || lead.phone

  return (
    <div className="flex flex-col h-full w-full bg-surface-base">
      {/* Cabeçalho */}
      <div className="flex items-center justify-between gap-2 border-b border-line-subtle bg-surface-panel px-4 py-3 shrink-0">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <Link
            href="/inbox"
            aria-label="Voltar para conversas"
            className="focus-ring md:hidden flex items-center justify-center h-11 w-11 -ml-2 shrink-0 rounded-[var(--r-md)] text-fg-muted transition-colors hover:text-fg hover:bg-surface-inset"
          >
            <ArrowLeft size={18} />
          </Link>
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-inset text-micro font-semibold text-fg-muted shrink-0">
            {displayName[0]?.toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="truncate text-h3 text-fg">{displayName}</p>
            <p className="truncate num text-micro text-fg-subtle">
              {lead.phone} · {eventLabels[lead.eventType] ?? lead.eventType}
              {lead.productName ? <span className="hidden sm:inline"> · {lead.productName}</span> : null}
            </p>
          </div>
        </div>
        <button
          onClick={() => refresh(false)}
          disabled={refreshing}
          aria-label="Atualizar mensagens"
          className="focus-ring h-11 w-11 lg:h-7 lg:w-7 -mr-2 lg:mr-0 shrink-0 flex items-center justify-center rounded-[var(--r-sm)] text-fg-subtle transition-colors hover:text-fg hover:bg-surface-inset disabled:opacity-40 cursor-pointer"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Mensagens */}
      <div className="scroll-thin flex-1 overflow-y-auto bg-surface-base px-4 py-4 space-y-1">
        <MessageList messages={messages} />
        <div ref={bottomRef} />
      </div>

      {/* Campo de envio */}
      {/* pb com safe area para o campo não encostar na barra de gestos do iOS */}
      <div className="border-t border-line-subtle bg-surface-panel p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:pb-3 shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Digite uma mensagem... (Enter para enviar, Shift+Enter para nova linha)"
            rows={1}
            className="focus-ring flex-1 resize-none rounded-[var(--r-md)] border border-line-subtle bg-surface-inset px-4 py-3 text-base lg:text-body text-fg placeholder:text-fg-subtle outline-none max-h-32 overflow-y-auto scroll-thin"
            style={{ minHeight: 44 }}
          />
          <button
            onClick={handleSend}
            disabled={!text.trim() || sending}
            aria-label="Enviar mensagem"
            className="focus-ring flex items-center justify-center h-11 w-11 shrink-0 rounded-[var(--r-md)] bg-brand-solid text-on-accent transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            <Send size={18} />
          </button>
        </div>
        <p className="text-micro text-fg-faint mt-1.5 px-1">Mensagem enviada via WhatsApp</p>
      </div>
    </div>
  )
}
