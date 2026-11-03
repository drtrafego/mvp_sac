'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, CircleStop, Headphones, Loader2, Mic, Play, ShieldCheck, Sparkles, Trash2, Upload, X } from 'lucide-react'
import { cn } from '@/lib/utils'

type Insight = {
  interpretation: string
  intent: string
  evidence: Array<{ label: string; value: string }>
  confidence: string
  state: 'interpreted' | 'blocked' | 'unavailable'
  proposedAction: string
  executedAction: string
  consent: string
  audit: string
  blockReason?: string
  source: 'conversation' | 'audio'
  transcript?: string
}
type AudioAsset = {
  id: number
  filename: string
  mimeType: string
  sizeBytes: number
  status: string
  transcript: string | null
  transcriptionProvider: string | null
  errorMessage: string | null
  aiInsight?: Insight | null
  createdAt: string | null
  mediaUrl: string
}

function formatBytes(value: number) {
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function statusLabel(value: string) {
  return ({
    recebido: 'Arquivo preservado',
    transcrito: 'Transcrito',
    interpreted: 'Interpretado',
    ai_bloqueada: 'IA bloqueada',
    transcricao_bloqueada: 'Transcrição bloqueada',
  } as Record<string, string>)[value] || value
}

export function ConversationAiPanel({ leadId }: { leadId: number }) {
  const [assets, setAssets] = useState<AudioAsset[]>([])
  const [insight, setInsight] = useState<Insight | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const [permission, setPermission] = useState<'unknown' | 'granted' | 'denied' | 'unsupported'>('unknown')
  const [error, setError] = useState<string | null>(null)
  const [secureContextError, setSecureContextError] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const discardRecordingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/inbox/${leadId}/ai`, { cache: 'no-store' })
      .then(async response => response.ok ? response.json() : null)
      .then(data => {
        if (cancelled || !data) return
        setAssets(Array.isArray(data.assets) ? data.assets : [])
        const previous = Array.isArray(data.assets) ? data.assets.find((asset: AudioAsset) => asset.status === 'interpreted' && asset.transcript) : null
        if (previous?.aiInsight) setInsight(previous.aiInsight)
      })
      .catch(() => { /* painel continua utilizável mesmo sem histórico */ })
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach(track => track.stop())
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
    // Initial load is intentionally tied to the conversation only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId])

  function clearFile() {
    setSelectedFile(null)
    setPreviewUrl(current => {
      if (current) URL.revokeObjectURL(current)
      return null
    })
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function selectFile(file: File | null) {
    if (!file) return
    if (!file.type.startsWith('audio/') && file.type !== 'video/webm') {
      setError('Escolha um arquivo de áudio compatível.'); return
    }
    if (file.size > 25 * 1024 * 1024) {
      setError('O áudio excede o limite de 25 MB.'); return
    }
    setError(null)
    setSelectedFile(file)
    setPreviewUrl(current => { if (current) URL.revokeObjectURL(current); return URL.createObjectURL(file) })
  }

  async function startRecording() {
    setError(null)
    if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(window.location.hostname)) {
      setSecureContextError('A gravação exige HTTPS. Abra o SAC em uma origem segura para liberar o microfone.')
      return
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setPermission('unsupported')
      setError('Este navegador não oferece gravação de áudio. Use o upload como fallback.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type)) || ''
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      chunksRef.current = []
      discardRecordingRef.current = false
      recorder.ondataavailable = event => { if (event.data.size) chunksRef.current.push(event.data) }
      recorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop())
        streamRef.current = null
        if (!discardRecordingRef.current) {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
          selectFile(new File([blob], `sac-gravacao-${Date.now()}.webm`, { type: blob.type }))
        }
        chunksRef.current = []
      }
      recorder.start()
      recorderRef.current = recorder
      setPermission('granted')
      setRecording(true)
    } catch (cause) {
      setPermission('denied')
      setError(cause instanceof DOMException && cause.name === 'NotAllowedError' ? 'Permissão do microfone negada. Libere o microfone no navegador ou use o upload.' : 'Não foi possível acessar o microfone. Use o upload como fallback.')
    }
  }

  function stopRecording(discard = false) {
    discardRecordingRef.current = discard
    recorderRef.current?.stop()
    recorderRef.current = null
    setRecording(false)
    if (discard) clearFile()
  }

  async function interpret() {
    if (busy) return
    setBusy(true); setError(null)
    const form = new FormData()
    if (selectedFile) form.set('audio', selectedFile)
    const idempotencyKey = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `audio_${Date.now()}_${Math.random().toString(36).slice(2)}`
    form.set('idempotencyKey', idempotencyKey)
    try {
      const response = await fetch(`/api/inbox/${leadId}/ai`, { method: 'POST', body: form, headers: { 'X-AI-Idempotency-Key': idempotencyKey } })
      const data = await response.json().catch(() => ({}))
      if (data.insight) setInsight(data.insight)
      if (data.asset) setAssets(current => [data.asset, ...current.filter(asset => asset.id !== data.asset.id)].slice(0, 10))
      if (!response.ok) throw new Error(data.error || 'A interpretação foi bloqueada.')
      clearFile()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao interpretar a conversa.')
    } finally { setBusy(false) }
  }

  const stateTone = insight?.state === 'interpreted' ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-amber-500/30 bg-amber-500/10'
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-brand-solid/30 bg-brand-glow p-3 space-y-2">
        <div className="flex items-start gap-2">
          <Sparkles size={16} className="mt-0.5 shrink-0 text-brand-ink" />
          <div>
            <h4 className="text-body font-bold text-fg">IA do atendimento</h4>
            <p className="text-micro text-fg-muted">Interpreta a conversa, propõe ações autorizadas e deixa a execução bloqueada até consentimento/revisão.</p>
          </div>
        </div>
        <button type="button" onClick={() => void interpret()} disabled={busy || recording} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand-solid px-3 py-2 text-micro font-bold text-on-accent disabled:opacity-50">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Interpretar conversa atual
        </button>
      </div>

      <div className="rounded-xl border border-line-subtle bg-surface-inset p-3 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2"><Headphones size={15} className="text-fg-subtle" /><span className="text-micro font-bold text-fg">Áudio para a IA</span></div>
          <span className="text-[10px] text-fg-faint">até 25 MB</span>
        </div>
        <p className="text-[11px] text-fg-muted">A gravação só começa após o clique. O áudio é preservado no SAC e enviado ao Hermes local configurado no servidor.</p>
        {secureContextError && <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-200">{secureContextError}</p>}
        <div className="grid grid-cols-2 gap-2">
          {!recording ? (
            <button type="button" onClick={() => void startRecording()} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-brand-solid/40 bg-brand-glow px-2 py-2 text-micro font-semibold text-brand-ink"><Mic size={14} /> Gravar áudio</button>
          ) : (
            <button type="button" onClick={() => stopRecording(false)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-2 text-micro font-semibold text-rose-300"><CircleStop size={14} /> Parar gravação</button>
          )}
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={recording} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-line-subtle bg-surface-panel px-2 py-2 text-micro font-semibold text-fg-muted disabled:opacity-40"><Upload size={14} /> Usar upload</button>
          <input ref={fileInputRef} type="file" accept="audio/*,video/webm" className="sr-only" onChange={event => selectFile(event.target.files?.[0] ?? null)} />
        </div>
        {recording && <div role="status" className="flex items-center justify-between rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-[11px] text-rose-300"><span className="flex items-center gap-1.5"><span className="h-2 w-2 animate-pulse rounded-full bg-rose-400" />Gravando com permissão do navegador</span><button type="button" onClick={() => stopRecording(true)} className="inline-flex items-center gap-1 text-fg-muted hover:text-fg"><Trash2 size={12} /> Cancelar</button></div>}
        {selectedFile && !recording && <div className="rounded-lg border border-line-subtle bg-surface-panel p-2 space-y-2"><div className="flex items-center justify-between gap-2 text-[11px]"><span className="min-w-0 truncate text-fg"><strong>{selectedFile.name}</strong> · {formatBytes(selectedFile.size)}</span><button type="button" onClick={clearFile} aria-label="Remover áudio" className="text-fg-subtle hover:text-fg"><X size={14} /></button></div>{previewUrl && <audio controls preload="metadata" src={previewUrl} className="h-8 w-full" />}</div>}
        {selectedFile && !recording && <button type="button" onClick={() => void interpret()} disabled={busy} className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-brand-solid/40 bg-brand-solid/10 px-3 py-2 text-micro font-bold text-brand-ink disabled:opacity-50">{busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Transcrever e interpretar áudio</button>}
        {permission === 'denied' && <p className="text-[11px] text-amber-300">Permissão negada. O upload continua disponível.</p>}
      </div>

      {error && <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-2.5 text-micro text-rose-300"><AlertCircle size={14} className="mt-0.5 shrink-0" /> <span>{error}</span></div>}

      {insight && <section className={cn('rounded-xl border p-3 space-y-2.5', stateTone)} aria-label="Resultado da interpretação da IA">
        <div className="flex items-center justify-between gap-2"><h4 className="text-micro font-bold uppercase tracking-wide text-fg">Leitura da IA</h4><span className="inline-flex items-center gap-1 text-[10px] font-semibold text-fg-muted">{insight.state === 'interpreted' ? <CheckCircle2 size={12} className="text-emerald-400" /> : <AlertCircle size={12} className="text-amber-300" />}{insight.state}</span></div>
        <div className="grid gap-2 text-[11px]"><p><strong className="text-fg">Interpretação:</strong> <span className="text-fg-muted">{insight.interpretation}</span></p><p><strong className="text-fg">Intenção:</strong> <span className="text-fg-muted">{insight.intent}</span></p><p><strong className="text-fg">Confiança/estado:</strong> <span className="text-fg-muted">{insight.confidence}</span></p><p><strong className="text-fg">Ação proposta:</strong> <span className="text-fg-muted">{insight.proposedAction}</span></p><p><strong className="text-fg">Execução:</strong> <span className="text-fg-muted">{insight.executedAction}</span></p><p><strong className="text-fg">Consentimento:</strong> <span className="text-fg-muted">{insight.consent}</span></p></div>
        <div className="border-t border-line-subtle/70 pt-2 space-y-1"><p className="text-[10px] font-bold uppercase tracking-wide text-fg-subtle">Evidências e auditoria</p>{insight.evidence.map((item, index) => <p key={`${item.label}-${index}`} className="text-[11px] text-fg-muted"><strong className="text-fg">{item.label}:</strong> {item.value}</p>)}<p className="text-[11px] text-fg-muted"><strong className="text-fg">Auditoria:</strong> {insight.audit}</p></div>
        {insight.blockReason && <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-2 text-[11px] text-amber-200"><strong>Bloqueio e próximo passo:</strong> {insight.blockReason} Confira a configuração no servidor e tente novamente.</p>}
        {insight.transcript && <p className="rounded-lg border border-line-subtle bg-surface-panel p-2 text-[11px] text-fg-muted"><strong className="text-fg">Transcrição:</strong> {insight.transcript}</p>}
      </section>}

      {assets.length > 0 && <section className="space-y-2"><div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-fg-subtle"><ShieldCheck size={12} /> Áudios preservados</div>{assets.map(asset => <div key={asset.id} className="rounded-lg border border-line-subtle bg-surface-inset p-2 space-y-1.5"><div className="flex items-center justify-between gap-2 text-[11px]"><span className="min-w-0 truncate text-fg">{asset.filename}</span><span className="shrink-0 text-fg-faint">{statusLabel(asset.status)}</span></div><audio controls preload="none" src={asset.mediaUrl} className="h-8 w-full" />{asset.transcript && <p className="text-[11px] text-fg-muted"><strong className="text-fg">Transcrição:</strong> {asset.transcript}</p>}{asset.errorMessage && <p className="text-[11px] text-rose-300">{asset.errorMessage}</p>}</div>)}</section>}
    </div>
  )
}
