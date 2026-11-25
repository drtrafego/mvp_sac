'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertCircle, CheckCircle2, ChevronRight, FileSpreadsheet, Layers, RefreshCw, Send } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { ImportLeadsModal } from '@/components/leads/ImportLeadsModal'

interface Batch {
  id: number
  fileName: string | null
  recipientCount: number
  status: string
  createdAt: string | null
  confirmedAt: string | null
  stats: {
    pending: number
    sent: number
    failed: number
    total: number
  }
}

interface DispatchPreview {
  batchId: number
  status: string
  recipientCount: number
  messageCount: number
  totalJobs: number
  messages: Array<{
    id: number
    order: number
    delayMinutes: number
    messageType: string
    content: string
    templateName: string | null
    templateLanguage: string | null
    templateVariablesMap: unknown
  }>
  stats: Record<string, number>
}

function batchStatusLabel(status: string): string {
  if (status === 'draft') return 'Rascunho · não enviado'
  if (status === 'queued') return 'Na fila · aguardando execução'
  if (status === 'delivered') return 'Entregue'
  if (status === 'read') return 'Lido'
  if (status === 'accepted') return 'Aceito pela Meta'
  if (status === 'partial_failure') return 'Falha parcial'
  if (status === 'completed') return 'Concluído'
  if (status === 'failed') return 'Falhou'
  return status
}

export default function DisparoEmMassaPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [importOpen, setImportOpen] = useState(false)
  const [batches, setBatches] = useState<Batch[]>([])
  const [loadingBatches, setLoadingBatches] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [preview, setPreview] = useState<DispatchPreview | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [dispatchConfirmed, setDispatchConfirmed] = useState(false)
  const [startingDispatch, setStartingDispatch] = useState(false)
  const [dispatchResult, setDispatchResult] = useState<string | null>(null)

  const selectedBatchId = Number.parseInt(searchParams.get('batchId') ?? '', 10)
  const hasSelectedBatch = Number.isInteger(selectedBatchId) && selectedBatchId > 0

  const fetchBatches = useCallback(async () => {
    setLoadingBatches(true)
    setLoadError(null)
    try {
      const response = await fetch('/api/leads/import')
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'Não foi possível carregar o histórico.')
      setBatches(payload.batches ?? [])
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Não foi possível carregar o histórico.')
    } finally {
      setLoadingBatches(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => { void fetchBatches() }, 0)
    return () => window.clearTimeout(timer)
  }, [fetchBatches])

  const fetchPreview = useCallback(async () => {
    if (!hasSelectedBatch) {
      setPreview(null)
      setPreviewError(null)
      setDispatchConfirmed(false)
      setDispatchResult(null)
      return
    }
    setLoadingPreview(true)
    setPreviewError(null)
    setDispatchResult(null)
    try {
      const response = await fetch(`/api/leads/import/${selectedBatchId}/dispatch`, { cache: 'no-store' })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'Não foi possível carregar o preview deste lote.')
      setPreview(payload)
    } catch (error) {
      setPreview(null)
      setPreviewError(error instanceof Error ? error.message : 'Não foi possível carregar o preview deste lote.')
    } finally {
      setLoadingPreview(false)
    }
  }, [hasSelectedBatch, selectedBatchId])

  useEffect(() => {
    const timer = window.setTimeout(() => { void fetchPreview() }, 0)
    return () => window.clearTimeout(timer)
  }, [fetchPreview])

  const startDispatch = async () => {
    if (!hasSelectedBatch || !preview || !dispatchConfirmed || preview.status !== 'draft') return
    setStartingDispatch(true)
    setPreviewError(null)
    setDispatchResult(null)
    try {
      const response = await fetch(`/api/leads/import/${selectedBatchId}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, previewMessages: preview.messages }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'Não foi possível iniciar o disparo.')
      setDispatchConfirmed(false)
      await Promise.all([fetchBatches(), fetchPreview()])
      setDispatchResult(`${payload.jobsCreated ?? 0} job(s) foram colocados na fila. A tela não envia mensagens sem esta confirmação.`)
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : 'Não foi possível iniciar o disparo.')
    } finally {
      setStartingDispatch(false)
    }
  }

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      <PageHeader
        icon={<Send size={22} />}
        title="Disparo em Massa (CSV)"
        description="Importe contatos, revise o mapeamento e gere um lote em rascunho. Nenhuma mensagem é enviada sem preview e confirmação explícita."
      />

      <section className="card flex flex-col items-start justify-between gap-5 rounded-2xl border border-line-subtle bg-surface-raised p-6 md:flex-row md:items-center">
        <div className="flex gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-brand-solid/30 bg-brand-glow text-brand-ink">
            <FileSpreadsheet size={22} />
          </div>
          <div>
            <h2 className="text-h3 font-bold text-fg">Preparar um disparo por CSV</h2>
            <p className="mt-1 max-w-2xl text-micro text-fg-muted">Selecione o arquivo, confira telefone e demais colunas, escolha a sequência e revise o preview antes de enfileirar.</p>
          </div>
        </div>
        <button onClick={() => setImportOpen(true)} className="btn btn-primary shrink-0 px-5 py-2.5 font-bold">
          Importar CSV
        </button>
      </section>

      <section className="card rounded-2xl border border-line-subtle bg-surface-raised p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Layers className="text-fg-subtle" size={18} />
            <h2 className="text-h3 font-bold text-fg">Histórico de Disparos em Massa</h2>
          </div>
          <button onClick={() => void fetchBatches()} className="rounded-xl p-2 text-fg-subtle transition-colors hover:bg-surface-inset hover:text-fg" title="Atualizar lotes">
            <RefreshCw className={loadingBatches ? 'animate-spin' : ''} size={16} />
          </button>
        </div>

        {loadError && <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-micro text-rose-400">{loadError}</p>}
        {!loadError && !loadingBatches && batches.length === 0 && <p className="py-4 text-micro italic text-fg-subtle">Nenhum disparo em massa realizado ainda.</p>}
        {batches.length > 0 && (
          <div className="space-y-3">
            {batches.map(batch => (
              <button key={batch.id} type="button" onClick={() => router.push(`/disparo-em-massa?batchId=${batch.id}`)} className="flex w-full flex-col justify-between gap-4 rounded-xl border border-line-subtle bg-surface-inset p-4 text-left transition-colors hover:border-brand-solid/50 md:flex-row md:items-center">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-body font-bold text-fg">{batch.fileName || `Lote #${batch.id}`}</span>
                    <span className="rounded-full border border-line-subtle bg-surface-raised px-2 py-0.5 text-[10px] font-bold text-fg-subtle">{batchStatusLabel(batch.status)}</span>
                  </div>
                  <p className="mt-1 text-micro text-fg-subtle">{batch.recipientCount} destinatários{batch.createdAt ? ` · Criado em ${new Date(batch.createdAt).toLocaleString('pt-BR')}` : ''}</p>
                </div>
                <div className="flex items-center justify-between gap-4 text-micro md:justify-end">
                  <div className="flex gap-4">
                    <span><strong className="text-emerald-400">{batch.stats.sent}</strong> enviados</span>
                    <span><strong className="text-rose-400">{batch.stats.failed}</strong> falhas</span>
                    <span><strong className="text-amber-400">{batch.stats.pending}</strong> pendentes</span>
                  </div>
                  <ChevronRight size={16} className="text-fg-subtle" />
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {hasSelectedBatch && (
        <section className="card rounded-2xl border border-line-subtle bg-surface-raised p-6">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-h3 font-bold text-fg">Revisão do lote #{selectedBatchId}</h2>
              <p className="mt-1 text-micro text-fg-muted">Criar o lote salva um rascunho. O envio só começa depois do preview e da confirmação explícita abaixo.</p>
            </div>
            <button type="button" onClick={() => router.push('/disparo-em-massa')} className="text-micro font-semibold text-fg-muted hover:text-fg">Fechar revisão</button>
          </div>

          {loadingPreview && <p className="text-micro text-fg-muted">Carregando o preview autoritativo do lote...</p>}
          {previewError && <p className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-micro text-rose-300"><AlertCircle size={16} className="mt-0.5 shrink-0" />{previewError}</p>}
          {dispatchResult && <p className="flex items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-micro text-emerald-300"><CheckCircle2 size={16} className="mt-0.5 shrink-0" />{dispatchResult}</p>}

          {preview && !loadingPreview && (
            <div className="space-y-4">
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                <p className="text-body font-bold text-fg">Status real: {batchStatusLabel(preview.status)}</p>
                <p className="mt-1 text-micro text-fg-muted">{preview.recipientCount} destinatário(s) elegível(is) · {preview.messageCount} mensagem(ns) por destinatário · {preview.totalJobs} job(s) previstos.</p>
              </div>

              {preview.messages.map(message => (
                <div key={`${message.id}-${message.order}`} className="rounded-xl border border-line-subtle bg-surface-inset p-4">
                  <p className="text-micro font-bold text-fg">Mensagem {message.order} · {message.messageType === 'template' ? `Template ${message.templateName ?? ''}` : message.messageType}</p>
                  <p className="mt-2 whitespace-pre-wrap text-body text-fg-muted">{message.content || 'Conteúdo definido pelo template aprovado.'}</p>
                  {message.templateLanguage && <p className="mt-2 text-micro text-fg-subtle">Idioma: {message.templateLanguage}</p>}
                </div>
              ))}

              {preview.status === 'draft' && (
                <>
                  <label className="flex items-start gap-2.5 rounded-xl border border-line-subtle bg-surface-inset p-3 text-micro text-fg cursor-pointer">
                    <input type="checkbox" checked={dispatchConfirmed} onChange={event => setDispatchConfirmed(event.target.checked)} className="mt-0.5 h-4 w-4" />
                    <span>Confirmo o disparo real para os {preview.recipientCount} contato(s) deste lote.</span>
                  </label>
                  <button type="button" onClick={() => void startDispatch()} disabled={!dispatchConfirmed || preview.messageCount === 0 || startingDispatch} className="btn btn-primary inline-flex items-center gap-2 px-5 py-2.5 font-bold disabled:cursor-not-allowed disabled:opacity-50">
                    <Send size={15} />{startingDispatch ? 'Iniciando envio...' : 'Iniciar envio deste lote'}
                  </button>
                </>
              )}
            </div>
          )}
        </section>
      )}

      <ImportLeadsModal open={importOpen} onOpenChange={setImportOpen} onSuccess={() => void fetchBatches()} />
    </div>
  )
}
