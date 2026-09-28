'use client'

import { useCallback, useEffect, useState } from 'react'
import { Tag, X, Loader2, Plus, UserCog, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

const PESSOA_TAG = 'pessoa'
const MAX_TAG_LENGTH = 50

interface LeadTagRow {
  tag: string
  createdAt: string | null
  createdBy: string | null
}

/**
 * Tags livres do lead (25/09/2026). Componente autocontido: busca e mantém
 * suas próprias tags via /api/leads/[leadId]/tags, e só avisa o pai
 * (ChatWindow) quando o efeito colateral da tag "pessoa" muda o estado do
 * bot (onBotPausedChange), pra manter o botão "Pausar/Retomar Bot" e o pill
 * de status sincronizados sem duplicar a fonte da verdade.
 */
export function LeadTags({
  leadId,
  botPaused,
  onBotPausedChange,
}: {
  leadId: number
  botPaused: boolean
  onBotPausedChange: (paused: boolean) => void
}) {
  const [tags, setTags] = useState<LeadTagRow[]>([])
  const [loading, setLoading] = useState(true)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)
  const [confirmingPessoa, setConfirmingPessoa] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/leads/${leadId}/tags`)
      if (res.ok) {
        const data = await res.json()
        setTags(Array.isArray(data.tags) ? data.tags : [])
      }
    } catch {
      /* silencioso, painel de detalhes não é crítico */
    } finally {
      setLoading(false)
    }
  }, [leadId])

  useEffect(() => {
    load() // eslint-disable-line react-hooks/set-state-in-effect -- fetch assíncrono, setState só corre depois do await, não durante o corpo do effect
  }, [load])

  const hasPessoa = tags.some(t => t.tag === PESSOA_TAG)

  async function addTag(value: string) {
    const trimmed = value.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setWarning(null)
    try {
      const res = await fetch(`/api/leads/${leadId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: trimmed }),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data) {
        setTags(Array.isArray(data.tags) ? data.tags : [])
        setInput('')
        if (data.warning) setWarning(data.warning)
        if (trimmed.toLowerCase() === PESSOA_TAG) onBotPausedChange(true)
      }
    } finally {
      setBusy(false)
      setConfirmingPessoa(false)
    }
  }

  async function removeTag(value: string) {
    if (busy) return
    setBusy(true)
    setWarning(null)
    try {
      const res = await fetch(`/api/leads/${leadId}/tags/${encodeURIComponent(value)}`, { method: 'DELETE' })
      const data = await res.json().catch(() => null)
      if (res.ok && data) {
        setTags(Array.isArray(data.tags) ? data.tags : [])
        if (data.warning) setWarning(data.warning)
        if (typeof data.botPaused === 'boolean') onBotPausedChange(data.botPaused)
      }
    } finally {
      setBusy(false)
    }
  }

  function handleAddClick() {
    const trimmed = input.trim()
    if (!trimmed) return
    if (trimmed.toLowerCase() === PESSOA_TAG && !confirmingPessoa) {
      setConfirmingPessoa(true)
      return
    }
    addTag(trimmed)
  }

  return (
    <div className="rounded-xl border border-line-subtle bg-surface-inset p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-micro font-bold uppercase text-fg-subtle">
          <Tag size={12} /> Tags
        </span>
        {hasPessoa && botPaused && (
          <span
            title="A tag 'pessoa' pausou o bot de IA deste lead"
            className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-600 dark:text-amber-400"
          >
            <UserCog size={11} /> bot pausado
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {loading && <Loader2 size={13} className="animate-spin text-fg-faint" />}
        {!loading && tags.length === 0 && (
          <span className="text-[11px] text-fg-faint">Nenhuma tag ainda</span>
        )}
        {tags.map(t => {
          const isPessoa = t.tag === PESSOA_TAG
          return (
            <span
              key={t.tag}
              title={t.createdBy ? `Marcada por ${t.createdBy}` : undefined}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold',
                isPessoa
                  ? 'border-rose-500/40 bg-rose-500/15 text-rose-600 dark:text-rose-400'
                  : 'border-line-subtle bg-surface-raised text-fg-muted'
              )}
            >
              {t.tag}
              <button
                type="button"
                onClick={() => removeTag(t.tag)}
                disabled={busy}
                aria-label={`Remover tag ${t.tag}`}
                className="rounded-full hover:bg-black/10 dark:hover:bg-white/10 disabled:opacity-40 cursor-pointer"
              >
                <X size={10} />
              </button>
            </span>
          )
        })}
      </div>

      {confirmingPessoa && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 space-y-1.5">
          <p className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400 font-medium">
            <TriangleAlert size={13} className="shrink-0 mt-0.5" />
            Marcar &quot;pessoa&quot; pausa o bot de IA deste lead agora (a Nina para de responder). Confirmar?
          </p>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => addTag(input)}
              disabled={busy}
              className="rounded-lg bg-amber-500 px-2.5 py-1 text-[11px] font-bold text-white hover:opacity-90 disabled:opacity-50 cursor-pointer"
            >
              {busy ? 'Confirmando…' : 'Confirmar e pausar bot'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingPessoa(false)}
              disabled={busy}
              className="rounded-lg border border-line-subtle px-2.5 py-1 text-[11px] font-semibold text-fg-muted hover:bg-surface-raised cursor-pointer"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleAddClick()
            }
          }}
          maxLength={MAX_TAG_LENGTH}
          placeholder="Nova tag..."
          disabled={busy}
          className="focus-ring flex-1 min-w-0 rounded-lg border border-line-subtle bg-surface-panel px-2.5 py-1.5 text-[12px] text-fg placeholder:text-fg-faint outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleAddClick}
          disabled={busy || !input.trim()}
          aria-label="Adicionar tag"
          title="Adicionar tag"
          className="h-8 w-8 shrink-0 flex items-center justify-center rounded-lg border border-line-subtle bg-surface-panel text-fg-subtle transition-colors hover:text-fg hover:bg-surface-raised disabled:opacity-40 cursor-pointer"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={14} />}
        </button>
      </div>

      {warning && (
        <p className="flex items-start gap-1.5 text-[10px] text-amber-600 dark:text-amber-400">
          <TriangleAlert size={12} className="shrink-0 mt-0.5" /> {warning}
        </p>
      )}
    </div>
  )
}
