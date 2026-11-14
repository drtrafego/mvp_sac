'use client'

import { useEffect, useRef, useState } from 'react'
import { CircleAlert, Loader2, Send, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'

type Job = { id: string; status: string; requestText: string; resultText?: string | null; resultJson?: { results?: Array<{ kind: string; data: unknown }> } | null; errorCode?: string | null; createdAt: string }
const terminal = new Set(['concluido', 'falhou', 'cancelado'])

function statusLabel(status: string) {
  return ({ pendente: 'pensando', em_execucao: 'pensando', concluido: 'executado', falhou: 'erro', cancelado: 'cancelado', aguardando_confirmacao: 'aguardando confirmação' } as Record<string, string>)[status] ?? status
}

export function OperatorConsole() {
  const [text, setText] = useState('')
  const [jobs, setJobs] = useState<Job[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timers = useRef<ReturnType<typeof setInterval> | null>(null)
  async function history() {
    const res = await fetch('/api/operator/messages', { cache: 'no-store' })
    if (!res.ok) return
    const data = await res.json() as { jobs?: Job[] }
    setJobs(data.jobs ?? [])
  }
  useEffect(() => { timers.current = setInterval(() => void history(), 4000); return () => { if (timers.current) clearInterval(timers.current) } }, [])
  async function submit() {
    if (!text.trim()) return
    setBusy(true); setError(null)
    try {
      const idempotencyKey = crypto.randomUUID()
      const res = await fetch('/api/operator/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text.trim(), idempotencyKey }) })
      const data = await res.json() as { error?: string; job?: Job }
      if (!res.ok) throw new Error(data.error ?? 'Não foi possível concluir a consulta.')
      if (data.job) setJobs(current => [data.job!, ...current.filter(job => job.id !== data.job!.id)])
      setText(''); void history()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Falha ao enviar o pedido.') }
    finally { setBusy(false) }
  }
  return <Card>
    <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck size={18} /> Consulte o SAC</CardTitle><CardDescription>Exemplos: “Quais são as etapas do pipeline?” ou “Liste as regras do Instagram”. Dados de leads aparecem mascarados.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      <Textarea value={text} onChange={event => setText(event.target.value)} maxLength={4000} rows={4} placeholder="Descreva a consulta que você quer fazer" />
      <div className="flex justify-end"><Button type="button" onClick={() => void submit()} disabled={busy || !text.trim()}>{busy ? <Loader2 className="animate-spin" /> : <Send />} Consultar</Button></div>
      {error && <p role="alert" className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"><CircleAlert size={16} />{error}</p>}
      <div className="space-y-3" aria-live="polite">
        {jobs.map(job => <article key={job.id} className="rounded-xl border border-line-subtle bg-surface-inset p-3 text-sm space-y-2">
          <div className="flex items-center justify-between gap-3"><strong>{statusLabel(job.status)}</strong><span className={terminal.has(job.status) ? 'text-fg-muted' : 'text-brand-ink'}>{job.id.slice(0, 8)}</span></div>
          <p className="text-fg-muted">{job.requestText}</p>
          {job.resultText && <p>{job.resultText}</p>}
          {job.resultJson?.results?.map((result, index) => <pre key={index} className="max-h-48 overflow-auto rounded-lg bg-background p-2 text-xs">{JSON.stringify(result.data, null, 2)}</pre>)}
          {job.errorCode && <p className="text-destructive">{job.errorCode}</p>}
        </article>)}
      </div>
    </CardContent>
  </Card>
}
