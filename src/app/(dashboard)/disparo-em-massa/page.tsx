'use client'

import { useCallback, useEffect, useState } from 'react'
import { FileSpreadsheet, Layers, RefreshCw, Send } from 'lucide-react'
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

export default function DisparoEmMassaPage() {
  const [importOpen, setImportOpen] = useState(false)
  const [batches, setBatches] = useState<Batch[]>([])
  const [loadingBatches, setLoadingBatches] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

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
    void fetchBatches()
  }, [fetchBatches])

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
              <div key={batch.id} className="flex flex-col justify-between gap-4 rounded-xl border border-line-subtle bg-surface-inset p-4 md:flex-row md:items-center">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-body font-bold text-fg">{batch.fileName || `Lote #${batch.id}`}</span>
                    <span className="rounded-full border border-line-subtle bg-surface-raised px-2 py-0.5 text-[10px] font-bold text-fg-subtle">{batch.status}</span>
                  </div>
                  <p className="mt-1 text-micro text-fg-subtle">{batch.recipientCount} destinatários{batch.createdAt ? ` · Criado em ${new Date(batch.createdAt).toLocaleString('pt-BR')}` : ''}</p>
                </div>
                <div className="flex gap-4 text-micro">
                  <span><strong className="text-emerald-400">{batch.stats.sent}</strong> enviados</span>
                  <span><strong className="text-rose-400">{batch.stats.failed}</strong> falhas</span>
                  <span><strong className="text-amber-400">{batch.stats.pending}</strong> pendentes</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <ImportLeadsModal open={importOpen} onOpenChange={setImportOpen} onSuccess={() => void fetchBatches()} />
    </div>
  )
}
