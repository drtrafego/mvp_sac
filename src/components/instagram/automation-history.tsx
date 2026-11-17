'use client'

import { useEffect, useRef, useState } from 'react'
import { Camera } from 'lucide-react'
import type { AutomationType, ReportPeriod, Totals, automationLogs } from '@/lib/instagram-automation-reporting'

type HistoryPage = NonNullable<Awaited<ReturnType<typeof automationLogs>>>
const statuses: Record<string, string> = {
  sent: 'Enviado', failed: 'Falhou', skipped: 'Ignorado', observed: 'Teste',
  reserved: 'Em processamento', unknown: 'Resultado não confirmado',
}
// Somente motivos seguros do relatório. Nunca renderizar erro bruto de integração.
const reasons = new Set([
  'Resposta anterior à ativação da regra.', 'Fora da janela de 24 horas.',
  'Lead não encontrado para releitura da pausa.', 'Modo teste: nenhum Direct foi enviado.',
  'Comentário já respondido manualmente antes da ativação da automação.',
  'Envio ignorado por pausa.', 'Limite de envios atingido.', 'Falha ao enviar a mensagem.',
  'Ativação ignorada.', 'Modo teste: nenhum envio realizado.',
  'Envio reservado ou em processamento.', 'Resultado do envio não confirmado.',
])
export function deliveryLabel(status: string, reason: string | null) {
  const label = statuses[status] ?? statuses.unknown
  return reason && reasons.has(reason) ? `${label}: ${reason}` : label
}
export function StoryBadge() {
  return <span className="inline-flex items-center gap-1 text-[10px] font-bold text-st-info bg-surface-raised border border-st-info rounded-full px-2 py-0.5"><Camera size={11} aria-hidden="true" />STORY</span>
}
export function RuleMetrics({ totals }: { totals?: Totals }) {
  return <div className="text-xs text-fg-muted space-y-2">
    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {(['disparos', 'enviados', 'falhas', 'ignorados'] as const).map((key, index) => <div key={key}><dt>{['Disparos', 'Enviados', 'Falhas', 'Ignorados'][index]}</dt><dd className="text-fg font-bold">{totals ? totals[key] : 'Indisponível'}</dd></div>)}
    </dl>
    <p>Última vez: {totals ? totals.ultimoDisparo ? new Date(totals.ultimoDisparo).toLocaleString('pt-BR') : 'Nenhum disparo' : 'Indisponível'}</p>
  </div>
}
export function AutomationHistory({ type, id, period, initiallyOpen = false }: { type: AutomationType; id: number; period?: ReportPeriod; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<HistoryPage | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const [retry, setRetry] = useState(0)
  const sequence = useRef(0)
  const from = period?.from
  const to = period?.to
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const requestId = ++sequence.current
    const load = async () => {
      setLoading(true); setError(false); setData(null)
      try {
        const query = new URLSearchParams({ page: String(page), limit: '10' })
        if (from && to) { query.set('from', from); query.set('to', to) }
        const response = await fetch(`/api/instagram-automations/${type}/${id}/logs?${query}`, { signal: controller.signal, cache: 'no-store' })
        if (!response.ok) throw new Error('history')
        const result: HistoryPage = await response.json()
        if (!controller.signal.aborted && requestId === sequence.current) setData(result)
      } catch {
        if (!controller.signal.aborted && requestId === sequence.current) setError(true)
      } finally {
        if (!controller.signal.aborted && requestId === sequence.current) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [open, type, id, page, from, to, retry])
  const regionId = `history-${type}-${id}`
  return <div className="border-t border-line-subtle pt-3 text-xs text-fg">
    <button className="font-semibold py-2 flex items-center gap-2" aria-expanded={open} aria-controls={regionId} onClick={() => setOpen(value => !value)}>
      {open ? 'Recolher histórico' : 'Ver histórico'} {type === 'story' && initiallyOpen && <StoryBadge />}
    </button>
    {open && <div id={regionId} aria-busy={loading}>
      {loading && <p role="status">Carregando histórico...</p>}
      {error && <div role="alert">Não foi possível carregar o histórico. <button className="underline" onClick={() => setRetry(value => value + 1)}>Tentar novamente</button></div>}
      {data && <>
        {data.logs.length === 0 && <p className="text-fg-muted py-2">Nenhum disparo neste período.</p>}
        <ul className="divide-y divide-line-subtle">{data.logs.map(log => <li key={log.id} className="py-3 space-y-1 break-words">
          <p className="text-fg-muted">{log.createdAt ? new Date(log.createdAt).toLocaleString('pt-BR') : 'Data indisponível'} · {log.commenterUsername ? `@${log.commenterUsername}` : log.senderId || 'Pessoa não identificada'}</p>
          <p>{deliveryLabel(log.status, log.reason)}</p>
        </li>)}</ul>
        <nav aria-label="Páginas do histórico" className="flex flex-wrap items-center gap-3 mt-3">
          <button disabled={loading || page === 1} onClick={() => setPage(value => value - 1)} className="border border-line-subtle rounded-lg p-2 disabled:opacity-50">Anterior</button>
          <span>Página {page} de {Math.max(1, Math.ceil(data.total / data.limit))}</span>
          <button disabled={loading || page * data.limit >= data.total} onClick={() => setPage(value => value + 1)} className="border border-line-subtle rounded-lg p-2 disabled:opacity-50">Próxima</button>
        </nav>
      </>}
    </div>}
  </div>
}
