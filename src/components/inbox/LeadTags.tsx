'use client'

import { useCallback, useEffect, useState } from 'react'
import { Tag, X, Loader2, Plus, UserCog, TriangleAlert } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const PESSOA_TAG = 'pessoa'
const MAX_TAG_LENGTH = 50

export interface TagItem {
  id?: number
  tag: string
  scopeChannel?: string | null
  createdBy?: string | null
  createdAt?: string | null
}

export function LeadTags({
  leadId,
  leadChannel = 'whatsapp',
  botPaused = false,
  onPessoaTagChange,
  onBotPausedChange,
}: {
  leadId: number
  leadChannel?: string
  botPaused?: boolean
  onPessoaTagChange?: (paused: boolean) => void
  onBotPausedChange?: (paused: boolean) => void
}) {
  const [tags, setTags] = useState<TagItem[]>([])
  const [loading, setLoading] = useState(true)
  const [newTagName, setNewTagName] = useState('')
  const [newTagScope, setNewTagScope] = useState('all')
  const [busy, setBusy] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)
  const [confirmingPessoa, setConfirmingPessoa] = useState(false)
  const [deletingTag, setDeletingTag] = useState<string | null>(null)

  const handleBotPausedChanged = (paused: boolean) => {
    onPessoaTagChange?.(paused)
    onBotPausedChange?.(paused)
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/leads/${leadId}/tags`)
      if (res.ok) {
        const data = await res.json()
        setTags(Array.isArray(data.tags) ? data.tags : [])
      }
    } catch {
      /* silencioso */
    } finally {
      setLoading(false)
    }
  }, [leadId])

  useEffect(() => {
    if (leadId) {
      load()
    }
  }, [leadId, load])

  const hasPessoa = tags.some((t) => t.tag === PESSOA_TAG)

  async function addTag(value: string) {
    const trimmed = value.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setWarning(null)
    try {
      const scopeVal = trimmed.toLowerCase() === PESSOA_TAG ? null : newTagScope === 'all' ? null : newTagScope
      const res = await fetch(`/api/leads/${leadId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: trimmed, scopeChannel: scopeVal }),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data) {
        setTags(Array.isArray(data.tags) ? data.tags : [])
        setNewTagName('')
        if (data.warning) setWarning(data.warning)
        if (trimmed.toLowerCase() === PESSOA_TAG) handleBotPausedChanged(true)
      }
    } finally {
      setBusy(false)
      setConfirmingPessoa(false)
    }
  }

  async function removeTag(value: string) {
    if (busy) return
    setBusy(true)
    setDeletingTag(value)
    setWarning(null)
    try {
      const res = await fetch(`/api/leads/${leadId}/tags/${encodeURIComponent(value)}`, { method: 'DELETE' })
      const data = await res.json().catch(() => null)
      if (res.ok && data) {
        setTags(Array.isArray(data.tags) ? data.tags : [])
        if (data.warning) setWarning(data.warning)
        if (typeof data.botPaused === 'boolean') handleBotPausedChanged(data.botPaused)
      }
    } finally {
      setBusy(false)
      setDeletingTag(null)
    }
  }

  function handleAddClick() {
    const trimmed = newTagName.trim()
    if (!trimmed) return
    if (trimmed.toLowerCase() === PESSOA_TAG && !confirmingPessoa) {
      setConfirmingPessoa(true)
      return
    }
    addTag(trimmed)
  }

  const isPessoaTyped = newTagName.trim().toLowerCase() === PESSOA_TAG

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-micro font-bold uppercase text-fg-subtle">
          <Tag size={12} className="text-cyan-400" /> Tags
        </span>
        {hasPessoa && botPaused && (
          <span
            title="A tag 'pessoa' pausou o bot de IA deste lead"
            className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-400"
          >
            <UserCog size={11} /> bot pausado
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {loading && <Loader2 size={13} className="animate-spin text-fg-faint" />}
        {!loading && tags.length === 0 && (
          <span className="text-[11px] text-fg-faint italic">Nenhuma tag atribuída</span>
        )}
        {tags.map((t) => {
          const isPessoa = t.tag === PESSOA_TAG
          const isDeleting = deletingTag === t.tag
          return (
            <span
              key={t.tag}
              title={t.createdBy ? `Marcada por ${t.createdBy}` : undefined}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-micro font-medium border transition-colors',
                isPessoa
                  ? 'bg-amber-500/15 border-amber-500/40 text-amber-300 font-bold'
                  : 'bg-surface-inset border-line-subtle text-fg'
              )}
            >
              <span>{t.tag}</span>
              <span className="text-[9px] opacity-70 font-mono">
                [{!t.scopeChannel ? 'Geral' : t.scopeChannel}]
              </span>
              <button
                type="button"
                onClick={() => removeTag(t.tag)}
                disabled={busy}
                aria-label={`Remover tag ${t.tag}`}
                className="hover:text-rose-400 text-fg-subtle cursor-pointer ml-0.5 disabled:opacity-40"
              >
                {isDeleting ? <Loader2 size={10} className="animate-spin" /> : <X size={10} />}
              </button>
            </span>
          )
        })}
      </div>

      {confirmingPessoa && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 space-y-1.5">
          <p className="flex items-start gap-1.5 text-[11px] text-amber-300 font-medium leading-tight">
            <TriangleAlert size={13} className="shrink-0 mt-0.5 text-amber-400" />
            Marcar &quot;pessoa&quot; pausará o bot de IA deste lead e notificará a ponte externa. Confirmar?
          </p>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => addTag(newTagName)}
              disabled={busy}
              className="rounded-lg bg-amber-500 px-2.5 py-1 text-[11px] font-bold text-black hover:opacity-90 disabled:opacity-50 cursor-pointer"
            >
              {busy ? 'Confirmando...' : 'Confirmar e pausar bot'}
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

      <div className="flex items-center gap-1.5 pt-1 border-t border-line-subtle">
        <input
          type="text"
          value={newTagName}
          onChange={(e) => setNewTagName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleAddClick()
            }
          }}
          maxLength={MAX_TAG_LENGTH}
          placeholder="Nova tag..."
          disabled={busy}
          className="h-8 text-micro bg-surface-inset border border-line-subtle rounded-md px-2 flex-1 text-fg placeholder:text-fg-faint focus:outline-none focus:border-cyan-500"
        />
        <Select
          value={newTagScope}
          onValueChange={(v) => v && setNewTagScope(v)}
          disabled={isPessoaTyped || busy}
        >
          <SelectTrigger className="h-8 text-micro bg-surface-inset border border-line-subtle rounded-md w-24 px-2">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-surface-overlay text-fg border border-line-subtle text-micro">
            <SelectItem value="all">Geral</SelectItem>
            <SelectItem value="whatsapp">WhatsApp</SelectItem>
            <SelectItem value="instagram">Instagram</SelectItem>
            <SelectItem value="email">E-mail</SelectItem>
            <SelectItem value="mineracao">Mineração</SelectItem>
          </SelectContent>
        </Select>
        <Button
          type="button"
          onClick={handleAddClick}
          disabled={busy || !newTagName.trim()}
          className="h-8 px-2.5 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 rounded-md text-micro font-bold cursor-pointer"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={13} />}
        </Button>
      </div>

      {warning && (
        <p className="flex items-start gap-1.5 text-[10px] text-amber-400">
          <TriangleAlert size={12} className="shrink-0 mt-0.5" /> {warning}
        </p>
      )}
    </div>
  )
}
