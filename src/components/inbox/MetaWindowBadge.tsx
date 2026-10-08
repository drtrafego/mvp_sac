'use client'

import { useState, useEffect } from 'react'
import { Clock, AlertTriangle, CheckCircle2, Lock, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getMetaWindowInfo } from '@/lib/meta-window'
import type { MetaWindowInfo } from '@/lib/meta-window'

// Cálculo da janela (getMetaWindowInfo) mora em src/lib/meta-window.ts e é
// reaproveitado pelo executor da fila (src/app/api/cron/route.ts) — não
// duplicar a regra de negócio aqui.
export { getMetaWindowInfo }
export type { MetaWindowInfo }

/**
 * Badge compacto para cards da lista de conversas
 */
export function MetaWindowBadge({
  lead,
  compact = false,
}: {
  lead: {
    trackingSource?: string | null
    eventType?: string | null
    utmCampaign?: string | null
    lastInboundAt?: string | null
    lastMessageAt?: string | null
    lastDirection?: string | null
  }
  compact?: boolean
}) {
  const [info, setInfo] = useState(() => getMetaWindowInfo(lead))

  // Atualiza a cada 60s
  useEffect(() => {
    setInfo(getMetaWindowInfo(lead))
    const timer = setInterval(() => {
      setInfo(getMetaWindowInfo(lead))
    }, 60_000)
    return () => clearInterval(timer)
  }, [lead.lastInboundAt, lead.trackingSource, lead.eventType, lead.utmCampaign])

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border text-[10px] tracking-tight px-1.5 py-0.5 whitespace-nowrap select-none transition-colors',
        info.badgeClass
      )}
      title={`Janela oficial da Meta (${info.typeLabel}): ${
        info.status === 'active'
          ? `${info.remainingHours}h ${info.remainingMinutes}m restantes para envio de mensagens normais`
          : info.status === 'expiring_soon'
          ? `Atenção: faltam apenas ${info.remainingHours}h ${info.remainingMinutes}m para expirar!`
          : info.status === 'expired'
          ? `Janela de ${info.windowHours}h fechada. Apenas templates aprovados podem ser enviados.`
          : 'Aguardando primeira resposta do lead.'
      }`}
    >
      {info.status === 'active' && <Clock size={11} className="shrink-0" />}
      {info.status === 'expiring_soon' && <AlertTriangle size={11} className="shrink-0 text-amber-500" />}
      {info.status === 'expired' && <Lock size={11} className="shrink-0 text-rose-500" />}
      {info.status === 'waiting_user' && <MessageSquare size={11} className="shrink-0 opacity-70" />}
      <span>{info.text}</span>
    </span>
  )
}

/**
 * Banner informativo de topo dentro da janela de chat (ChatWindow)
 */
export function MetaWindowBanner({
  lead,
}: {
  lead: {
    trackingSource?: string | null
    eventType?: string | null
    utmCampaign?: string | null
    lastInboundAt?: string | null
    lastMessageAt?: string | null
    lastDirection?: string | null
  }
}) {
  const [info, setInfo] = useState(() => getMetaWindowInfo(lead))

  useEffect(() => {
    setInfo(getMetaWindowInfo(lead))
    const timer = setInterval(() => {
      setInfo(getMetaWindowInfo(lead))
    }, 30_000)
    return () => clearInterval(timer)
  }, [lead.lastInboundAt, lead.trackingSource, lead.eventType, lead.utmCampaign])

  if (info.status === 'expired') {
    return (
      <div className="flex items-center justify-between gap-3 px-4 py-2 bg-rose-500/10 border-b border-rose-500/20 text-rose-700 dark:text-rose-400 text-micro">
        <div className="flex items-center gap-2">
          <Lock size={14} className="shrink-0 text-rose-500" />
          <span>
            <strong>Janela de 24h Fechada:</strong> Mais de 24 horas se passaram desde a última mensagem enviada pelo cliente. A Meta bloqueia mensagens normais e exige um <strong>Template Aprovado</strong> para retomar o contato.
          </span>
        </div>
        <a
          href="/api-modelos"
          className="shrink-0 font-bold underline hover:opacity-80 text-[11px]"
        >
          Modelos / Templates &rarr;
        </a>
      </div>
    )
  }

  if (info.status === 'expiring_soon') {
    return (
      <div className="flex items-center justify-between gap-3 px-4 py-2 bg-amber-500/15 border-b border-amber-500/25 text-amber-800 dark:text-amber-300 text-micro animate-pulse">
        <div className="flex items-center gap-2">
          <AlertTriangle size={14} className="shrink-0 text-amber-600" />
          <span>
            <strong>Janela de 24h Expirando:</strong> Restam apenas <strong>{info.remainingHours}h {info.remainingMinutes}m</strong> desde a última mensagem do cliente para envio livre. Templates aprovados continuam disponíveis fora dela.
          </span>
        </div>
      </div>
    )
  }

  if (info.status === 'active') {
    return (
      <div className="flex items-center justify-between gap-3 px-4 py-1.5 bg-emerald-500/10 border-b border-emerald-500/20 text-emerald-800 dark:text-emerald-300 text-micro">
        <div className="flex items-center gap-2">
          <CheckCircle2 size={13} className="shrink-0 text-emerald-500" />
          <span>
            <strong>Janela de 24h Aberta:</strong> Restam <strong>{info.remainingHours}h {info.remainingMinutes}m</strong> para envio de mensagens livres (contados a partir da última mensagem do cliente). Templates aprovados podem ser enviados fora dela.
          </span>
        </div>
        <span className="text-[10px] font-mono opacity-80 shrink-0">Regra Oficial WhatsApp Meta: 24h</span>
      </div>
    )
  }

  // waiting_user
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-1.5 bg-surface-inset border-b border-line-subtle text-fg-subtle text-micro">
      <div className="flex items-center gap-2">
        <MessageSquare size={13} className="shrink-0 text-fg-faint" />
        <span>
          <strong>Aguardando Resposta do Cliente:</strong> Assim que a pessoa responder, uma janela oficial de <strong>24 horas</strong> será iniciada automaticamente.
        </span>
      </div>
    </div>
  )
}
