'use client'

import React, { useState, useEffect } from 'react'
import { Upload, FileText, CheckCircle, AlertTriangle, Send, RefreshCw, Layers, ShieldCheck, Users, ArrowRight } from 'lucide-react'

interface Batch {
  id: number
  fileName: string
  recipientCount: number
  status: string
  createdAt: string
  confirmedAt?: string | null
  stats?: {
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
  eventType: string
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
    templateVariablesMap: Record<string, string> | null
  }>
}

export default function DisparoEmMassaPage() {
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  
  const [activeBatchId, setActiveBatchId] = useState<number | null>(null)
  const [preview, setPreview] = useState<DispatchPreview | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const [batches, setBatches] = useState<Batch[]>([])
  const [loadingBatches, setLoadingBatches] = useState(false)

  const fetchBatches = async () => {
    setLoadingBatches(true)
    try {
      const res = await fetch('/api/leads/import')
      if (res.ok) {
        const data = await res.json()
        setBatches(data.batches || [])
      }
    } catch (err) {
      console.error('Erro ao buscar lotes:', err)
    } finally {
      setLoadingBatches(false)
    }
  }

  useEffect(() => {
    fetchBatches()
  }, [])

  const handleFileUpload = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file) return

    setUploading(true)
    setUploadError(null)
    setSuccessMessage(null)

    try {
      const formData = new FormData()
      formData.append('file', file)

      const res = await fetch('/api/leads/import', {
        method: 'POST',
        body: formData,
      })

      const data = await res.json()
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Falha ao importar o arquivo CSV.')
      }

      setActiveBatchId(data.batchId)
      fetchPreview(data.batchId)
      fetchBatches()
    } catch (err: any) {
      setUploadError(err.message || 'Erro no envio do CSV.')
    } finally {
      setUploading(false)
    }
  }

  const fetchPreview = async (batchId: number) => {
    setLoadingPreview(true)
    try {
      const res = await fetch(`/api/leads/import/${batchId}/dispatch`)
      if (res.ok) {
        const data = await res.json()
        setPreview(data)
      } else {
        const errData = await res.json()
        setUploadError(errData.error || 'Falha ao gerar o preview do disparo.')
      }
    } catch (err: any) {
      setUploadError('Erro ao consultar o preview do disparo.')
    } finally {
      setLoadingPreview(false)
    }
  }

  const handleConfirmDispatch = async () => {
    if (!activeBatchId) return

    setConfirming(true)
    setConfirmError(null)

    try {
      const res = await fetch(`/api/leads/import/${activeBatchId}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      })

      const data = await res.json()
      if (!res.ok || !data.ok) {
        throw new Error(data.error || data.message || 'Falha ao confirmar disparo em massa.')
      }

      setSuccessMessage(`Disparo em massa enfileirado com sucesso! ${data.jobsCreated || data.jobsQueued || ''} mensagens agendadas.`)
      setActiveBatchId(null)
      setPreview(null)
      setFile(null)
      fetchBatches()
    } catch (err: any) {
      setConfirmError(err.message || 'Erro ao confirmar o disparo em massa.')
    } finally {
      setConfirming(false)
    }
  }

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      {/* HEADER */}
      <div className="rise rise-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-wider text-brand-ink bg-brand-glow px-2.5 py-0.5 rounded-full border border-brand-solid/30">
            <Send size={12} />
            API Oficial · Disparo em Massa
          </span>
        </div>
        <h1 className="text-h1 text-fg">Disparo em Massa (CSV)</h1>
        <p className="text-body text-fg-muted mt-0.5">
          Importe uma lista de contatos via CSV e envie campanhas oficiais aprovadas pela Meta Cloud API com variáveis personalizadas.
        </p>
      </div>

      {/* ALERT DE SUCESSO */}
      {successMessage && (
        <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CheckCircle className="shrink-0 text-emerald-400" size={20} />
            <span className="text-body font-medium">{successMessage}</span>
          </div>
          <button onClick={() => setSuccessMessage(null)} className="text-micro font-bold underline text-emerald-400">
            Fechar
          </button>
        </div>
      )}

      {/* PASSO 1: UPLOAD DE CSV */}
      <div className="card bg-surface-raised border border-line-subtle p-6 rounded-2xl space-y-4">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-glow border border-brand-solid/30 text-brand-ink font-bold text-sm">
            1
          </span>
          <div>
            <h2 className="text-h3 text-fg font-bold">Importar Lista de Contatos (CSV)</h2>
            <p className="text-micro text-fg-muted">O arquivo deve conter as colunas de <strong>telefone</strong> e variáveis como <strong>nome</strong>.</p>
          </div>
        </div>

        <form onSubmit={handleFileUpload} className="space-y-4 pt-2">
          <div className="border-2 border-dashed border-line-subtle hover:border-brand-solid/50 rounded-2xl p-6 text-center transition-colors">
            <input
              type="file"
              accept=".csv"
              id="csv-file-input"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
            <label htmlFor="csv-file-input" className="cursor-pointer flex flex-col items-center justify-center gap-2">
              <Upload className="text-brand-ink" size={32} />
              <span className="text-body font-semibold text-fg">
                {file ? file.name : 'Clique para selecionar um arquivo .CSV'}
              </span>
              <span className="text-micro text-fg-subtle">Suporta formato padrão UTF-8 separado por vírgula ou ponto-e-vírgula</span>
            </label>
          </div>

          {uploadError && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-micro flex items-center gap-2">
              <AlertTriangle size={16} />
              <span>{uploadError}</span>
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={!file || uploading}
              className="btn btn-primary px-6 py-2.5 rounded-xl font-bold flex items-center gap-2 disabled:opacity-50"
            >
              {uploading ? <RefreshCw className="animate-spin" size={16} /> : <FileText size={16} />}
              {uploading ? 'Carregando CSV...' : 'Gerar Preview do Disparo'}
            </button>
          </div>
        </form>
      </div>

      {/* PASSO 2: PREVIEW E CONFIRMAÇÃO DO DISPARO */}
      {loadingPreview && (
        <div className="card bg-surface-raised border border-line-subtle p-6 rounded-2xl text-center space-y-3">
          <RefreshCw className="animate-spin text-brand-ink mx-auto" size={24} />
          <p className="text-body font-medium text-fg">Consultando destinatários elegíveis e mensagens aprovadas...</p>
        </div>
      )}

      {preview && (
        <div className="card bg-surface-raised border border-brand-solid/40 p-6 rounded-2xl space-y-6">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-glow border border-brand-solid/30 text-brand-ink font-bold text-sm">
              2
            </span>
            <div>
              <h2 className="text-h3 text-fg font-bold">Preview do Disparo em Massa</h2>
              <p className="text-micro text-fg-muted">Confira os destinatários e o modelo de mensagem aprovado pela Meta antes de confirmar.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 rounded-xl bg-surface-inset border border-line-subtle space-y-1">
              <span className="text-micro text-fg-subtle">Destinatários Elegíveis</span>
              <p className="text-h2 font-bold text-fg">{preview.recipientCount}</p>
            </div>
            <div className="p-4 rounded-xl bg-surface-inset border border-line-subtle space-y-1">
              <span className="text-micro text-fg-subtle">Mensagens por Lead</span>
              <p className="text-h2 font-bold text-fg">{preview.messageCount}</p>
            </div>
            <div className="p-4 rounded-xl bg-surface-inset border border-line-subtle space-y-1">
              <span className="text-micro text-fg-subtle">Total de Envios na Fila</span>
              <p className="text-h2 font-bold text-brand-ink">{preview.totalJobs}</p>
            </div>
          </div>

          {/* MENSAGENS E TEMPLATES */}
          <div className="space-y-3">
            <h4 className="text-body font-bold text-fg">Mensagens que serão enviadas:</h4>
            {preview.messages.map((m) => (
              <div key={m.id} className="p-4 rounded-xl bg-surface-inset border border-line-subtle space-y-2">
                <div className="flex items-center justify-between text-micro font-bold">
                  <span className="text-brand-ink uppercase tracking-wider">
                    {m.templateName ? `Template Meta: ${m.templateName}` : 'Mensagem de Texto'}
                  </span>
                  <span className="text-fg-subtle">
                    {m.delayMinutes > 0 ? `⏱️ Aguarda ${m.delayMinutes} min` : '⚡ Envio imediato'}
                  </span>
                </div>
                <p className="text-body text-fg whitespace-pre-wrap">{m.content || '(Conteúdo carregado via template oficial Meta)'}</p>
              </div>
            ))}
          </div>

          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-micro flex items-start gap-3">
            <ShieldCheck className="shrink-0 mt-0.5 text-amber-400" size={18} />
            <div>
              <strong className="font-bold text-amber-200">Proteção de envio da Meta:</strong>
              <p className="mt-0.5">O envio usa somente templates aprovados pela Meta Cloud API. Templates não dependem da janela de 24h; o limite técnico de volume e o bloqueio de bot pausado são aplicados automaticamente.</p>
            </div>
          </div>

          {confirmError && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-micro flex items-center gap-2">
              <AlertTriangle size={16} />
              <span>{confirmError}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              onClick={() => { setActiveBatchId(null); setPreview(null); }}
              className="px-4 py-2 rounded-xl text-micro font-semibold text-fg-subtle hover:text-fg hover:bg-surface-inset"
            >
              Cancelar
            </button>
            <button
              onClick={handleConfirmDispatch}
              disabled={confirming || preview.recipientCount === 0}
              className="btn btn-primary px-6 py-2.5 rounded-xl font-bold flex items-center gap-2 disabled:opacity-50"
            >
              {confirming ? <RefreshCw className="animate-spin" size={16} /> : <Send size={16} />}
              {confirming ? 'Confirmando Disparo...' : 'CONFIRMAR E DISPARAR AGORA'}
            </button>
          </div>
        </div>
      )}

      {/* ACOMPANHAMENTO DOS LOTES ANTERIORES */}
      <div className="card bg-surface-raised border border-line-subtle p-6 rounded-2xl space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="text-fg-subtle" size={18} />
            <h2 className="text-h3 text-fg font-bold">Histórico de Disparos em Massa</h2>
          </div>
          <button
            onClick={fetchBatches}
            className="p-2 rounded-xl text-fg-subtle hover:text-fg hover:bg-surface-inset transition-colors"
            title="Atualizar Lotes"
          >
            <RefreshCw className={loadingBatches ? 'animate-spin' : ''} size={16} />
          </button>
        </div>

        {batches.length === 0 ? (
          <p className="text-micro text-fg-subtle italic py-4">Nenhum disparo em massa realizado ainda.</p>
        ) : (
          <div className="space-y-3">
            {batches.map((b) => (
              <div key={b.id} className="p-4 rounded-xl bg-surface-inset border border-line-subtle flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-fg text-body">{b.fileName || `Lote #${b.id}`}</span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                      b.status === 'queued' || b.status === 'processing'
                        ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                        : b.status === 'completed'
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                        : 'bg-surface-raised text-fg-subtle border-line-subtle'
                    }`}>
                      {b.status === 'queued' ? 'Na Fila' : b.status === 'completed' ? 'Concluído' : b.status}
                    </span>
                  </div>
                  <p className="text-micro text-fg-subtle">
                    {b.recipientCount} destinatários · Criado em {new Date(b.createdAt).toLocaleString('pt-BR')}
                  </p>
                </div>

                {b.stats && (
                  <div className="flex items-center gap-4 text-micro">
                    <div>
                      <span className="text-fg-subtle block">Enviados</span>
                      <strong className="text-emerald-400 font-bold">{b.stats.sent}</strong>
                    </div>
                    <div>
                      <span className="text-fg-subtle block">Falhas</span>
                      <strong className="text-rose-400 font-bold">{b.stats.failed}</strong>
                    </div>
                    <div>
                      <span className="text-fg-subtle block">Pendentes</span>
                      <strong className="text-amber-400 font-bold">{b.stats.pending}</strong>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
