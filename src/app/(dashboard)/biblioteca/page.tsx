'use client'

import { useState, useEffect } from 'react'
import { Download, MessageSquare, Check } from 'lucide-react'

interface PresetMessage {
  order: number
  delayMinutes: number
  messageType: string
  content: string
}

interface PresetSequence {
  id: string
  nicho: string
  eventType: string
  name: string
  description: string
  messages: PresetMessage[]
}

const eventTypeLabels: Record<string, string> = {
  boleto: 'Boleto',
  pix: 'Pix',
  carrinho_abandonado: 'Carrinho',
  cartao_recusado: 'Cartão recusado',
  compra_aprovada: 'Compra aprovada',
}

const eventTypeVar: Record<string, string> = {
  boleto: 'var(--ev-boleto)',
  pix: 'var(--ev-pix)',
  carrinho_abandonado: 'var(--ev-carrinho)',
  cartao_recusado: 'var(--ev-cartao)',
  compra_aprovada: 'var(--ev-aprovada)',
}

function formatDelay(minutes: number): string {
  if (minutes < 60) return `${minutes}min`
  if (minutes < 1440) return `${minutes / 60}h`
  return `${minutes / 1440}d`
}

export default function BibliotecaPage() {
  const [presets, setPresets] = useState<PresetSequence[]>([])
  const [importing, setImporting] = useState<string | null>(null)
  const [imported, setImported] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/biblioteca').then(r => r.json()).then(setPresets)
  }, [])

  async function handleImport(presetId: string) {
    setImporting(presetId)
    try {
      const res = await fetch('/api/biblioteca', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ presetId }),
      })
      if (res.ok) {
        setImported(prev => new Set([...prev, presetId]))
        setTimeout(() => setImported(prev => {
          const next = new Set(prev)
          next.delete(presetId)
          return next
        }), 3000)
      }
    } finally {
      setImporting(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="rise rise-1">
        <h1 className="text-h1 text-fg">Biblioteca de sequências</h1>
        <p className="text-body text-fg-muted mt-1 max-w-[70ch]">
          Importe sequências prontas e já comprovadas. As mensagens são adicionadas à sequência existente, você pode editar depois.
        </p>
      </div>

      <div className="grid gap-3 rise rise-2">
        {presets.map(preset => {
          const color = eventTypeVar[preset.eventType] ?? 'var(--fg-faint)'
          const isOpen = expanded === preset.id
          return (
            <div key={preset.id} className="card overflow-hidden">
              <div className="flex flex-col gap-4 p-5 md:flex-row md:items-start">
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                    <span className="inline-flex items-center gap-1.5 text-micro text-fg-muted">
                      <span className="dot" style={{ color }} />
                      {eventTypeLabels[preset.eventType] ?? preset.eventType}
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-micro text-fg-subtle">
                      <MessageSquare size={12} />
                      <span className="num">{preset.messages.length}</span> mensagens
                    </span>
                  </div>
                  <h2 className="text-h3 text-fg">{preset.name}</h2>
                  <p className="text-body text-fg-muted mt-1">{preset.description}</p>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => setExpanded(isOpen ? null : preset.id)}
                    className="focus-ring inline-flex h-[var(--control-lg)] items-center rounded-[var(--r-sm)] border border-line-default px-3 text-body font-medium text-fg-muted transition-colors hover:text-fg lg:h-[var(--control-md)]"
                  >
                    {isOpen ? 'Fechar' : 'Ver mensagens'}
                  </button>
                  <button
                    onClick={() => handleImport(preset.id)}
                    disabled={importing === preset.id}
                    className="focus-ring inline-flex h-[var(--control-lg)] items-center gap-1.5 rounded-[var(--r-sm)] bg-brand-solid px-3.5 text-body font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50 lg:h-[var(--control-md)]"
                  >
                    {imported.has(preset.id)
                      ? <><Check size={14} /> Importado</>
                      : importing === preset.id
                      ? 'Importando...'
                      : <><Download size={14} /> Importar</>
                    }
                  </button>
                </div>
              </div>

              {isOpen && (
                <div className="space-y-2.5 border-t border-line-subtle bg-surface-inset px-5 py-4">
                  {preset.messages.map((msg) => (
                    <div key={msg.order} className="flex items-start gap-3">
                      <span className="num flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-raised text-micro text-fg-muted">
                        {msg.order}
                      </span>
                      <div className="min-w-0 flex-1">
                        <span className="num text-micro text-fg-subtle mr-2">+{formatDelay(msg.delayMinutes)}</span>
                        <span className="text-body text-fg-muted">
                          {msg.content.slice(0, 100)}{msg.content.length > 100 ? '...' : ''}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
