'use client'

import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, CircleAlert, Loader2, Mic, Send, ShieldCheck } from 'lucide-react'

type Job = {
  jobId: string
  status: string
  transcript?: string | null
  intent?: string | null
  targetText?: string | null
  mediaId?: string | null
  result?: { question?: string; commentId?: string; permalink?: string; error?: string } | null
  errorMessage?: string | null
}

export function CodexActionConsole() {
  const [text, setText] = useState('')
  const [mediaId, setMediaId] = useState('')
  const [audio, setAudio] = useState<File | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => () => { if (timer.current) clearInterval(timer.current) }, [])

  async function refresh(jobId: string) {
    const response = await fetch(`/api/codex/actions/${encodeURIComponent(jobId)}`, { cache: 'no-store' })
    if (!response.ok) return
    const data = await response.json()
    setJob(data.job)
    if (['concluido', 'erro'].includes(data.job?.status)) {
      if (timer.current) clearInterval(timer.current)
      timer.current = null
    }
  }

  async function submit() {
    if (!text.trim() && !audio) return
    setBusy(true); setError(null)
    const form = new FormData()
    if (text.trim()) form.set('text', text.trim())
    if (audio) form.set('audio', audio)
    if (mediaId.trim()) form.set('context', JSON.stringify({ mediaId: mediaId.trim(), surface: 'painel_sac' }))
    try {
      const response = await fetch('/api/codex/actions', { method: 'POST', body: form })
      const data = await response.json()
      if (!response.ok && !data.job) throw new Error(data.error || 'Não foi possível enviar ao Codex.')
      setJob(data.job)
      if (data.job?.jobId) {
        if (timer.current) clearInterval(timer.current)
        timer.current = setInterval(() => void refresh(data.job.jobId), 2500)
      }
      setAudio(null); setText('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao enviar o comando.')
    } finally { setBusy(false) }
  }

  async function confirm() {
    if (!job) return
    setBusy(true); setError(null)
    try {
      const response = await fetch(`/api/codex/actions/${encodeURIComponent(job.jobId)}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'A confirmação foi recusada.')
      setJob(data.job)
      if (timer.current) clearInterval(timer.current)
      timer.current = setInterval(() => void refresh(job.jobId), 2500)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Falha na confirmação.') }
    finally { setBusy(false) }
  }

  const waiting = job?.status === 'aguardando_confirmacao' && !job.result?.commentId
  return (
    <section className="panel p-[var(--space-card)] space-y-4">
      <div className="flex items-start gap-3">
        <ShieldCheck size={18} className="text-brand-ink mt-0.5" />
        <div>
          <h2 className="text-h2 text-fg">Ações do Codex</h2>
          <p className="text-body text-fg-muted">Texto ou áudio passa pelo Whisper local do Hermes. O Codex avalia e executa somente operações autorizadas.</p>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_220px]">
        <textarea value={text} onChange={event => setText(event.target.value)} placeholder="Ex.: crie este comentário no Instagram: ..." rows={3} className="rounded-xl border border-line-subtle bg-surface-inset p-3 text-body text-fg" />
        <div className="space-y-2">
          <input value={mediaId} onChange={event => setMediaId(event.target.value)} placeholder="media_id do post/reel" className="w-full rounded-xl border border-line-subtle bg-surface-inset p-3 text-body text-fg" />
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-line-subtle bg-surface-inset p-3 text-micro text-fg-muted"><Mic size={15} />{audio ? audio.name : 'Anexar áudio'}<input type="file" accept="audio/*,video/webm" className="sr-only" onChange={event => setAudio(event.target.files?.[0] ?? null)} /></label>
          <button type="button" onClick={() => void submit()} disabled={busy || (!text.trim() && !audio)} className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-solid p-3 text-micro font-bold text-on-accent disabled:opacity-40">{busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Enviar ao Codex</button>
        </div>
      </div>
      {error && <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-micro text-rose-300">{error}</p>}
      {job && <div className="rounded-xl border border-line-subtle bg-surface-inset p-3 space-y-2 text-micro">
        <div className="flex items-center justify-between"><strong className="text-fg">Job {job.jobId.slice(0, 8)}</strong><span className="text-brand-ink font-bold">{job.status}</span></div>
        {job.transcript && <p className="text-fg-muted"><strong className="text-fg">Transcrição:</strong> {job.transcript}</p>}
        {job.targetText && <p className="text-fg-muted"><strong className="text-fg">Comentário alvo:</strong> {job.targetText}</p>}
        {waiting && <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-amber-200"><span>{job.result?.question || 'O Codex pede confirmação antes de publicar.'}</span><button type="button" onClick={() => void confirm()} disabled={busy} className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-amber-400 px-3 py-1.5 font-bold text-slate-950"><CheckCircle2 size={14} /> Confirmar</button></div>}
        {job.result?.permalink && <p className="text-emerald-300">Publicado: <a href={job.result.permalink} target="_blank" rel="noreferrer" className="underline">abrir no Instagram</a>{job.result.commentId ? ` · ID ${job.result.commentId}` : ''}</p>}
        {job.errorMessage && <p className="flex items-center gap-1 text-rose-300"><CircleAlert size={14} />{job.errorMessage}</p>}
      </div>}
    </section>
  )
}
