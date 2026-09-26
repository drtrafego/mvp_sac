'use client'

import { useState, useEffect } from 'react'
import { Tag, Plus, X, AlertTriangle, Loader2 } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface TagItem {
  id?: number
  tag: string
  scopeChannel: string | null
  createdBy?: string | null
  createdAt?: string | null
}

interface LeadTagsProps {
  leadId: number
  leadChannel?: string
  onPessoaTagChange?: (paused: boolean) => void
}

export function LeadTags({ leadId, leadChannel = 'whatsapp', onPessoaTagChange }: LeadTagsProps) {
  const [tags, setTags] = useState<TagItem[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [newTagName, setNewTagName] = useState('')
  const [newTagScope, setNewTagScope] = useState('all')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [deletingTag, setDeletingTag] = useState<string | null>(null)

  const fetchTags = async () => {
    try {
      setLoading(true)
      const res = await fetch(`/api/leads/${leadId}/tags`)
      if (res.ok) {
        const data = await res.json()
        setTags(data.tags || [])
      }
    } catch (err) {
      console.error('[LeadTags] Erro ao carregar tags:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (leadId) {
      fetchTags()
    }
  }, [leadId])

  const handleAddTag = async () => {
    const raw = newTagName.trim()
    if (!raw) return

    setAdding(true)
    setErrorMsg(null)

    try {
      const scopeVal = raw.toLowerCase() === 'pessoa' ? null : (newTagScope === 'all' ? null : newTagScope)
      const res = await fetch(`/api/leads/${leadId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tag: raw,
          scopeChannel: scopeVal,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        setErrorMsg(data.error || 'Erro ao adicionar tag')
        return
      }

      setNewTagName('')
      if (raw.toLowerCase() === 'pessoa') {
        onPessoaTagChange?.(true)
      }
      await fetchTags()
    } catch (err) {
      setErrorMsg('Erro de conexão ao adicionar tag')
    } finally {
      setAdding(false)
    }
  }

  const handleDeleteTag = async (tagName: string) => {
    setDeletingTag(tagName)
    try {
      const res = await fetch(`/api/leads/${leadId}/tags/${encodeURIComponent(tagName)}`, {
        method: 'DELETE',
      })

      if (res.ok) {
        if (tagName.toLowerCase() === 'pessoa') {
          onPessoaTagChange?.(false)
        }
        await fetchTags()
      }
    } catch (err) {
      console.error('[LeadTags] Erro ao deletar tag:', err)
    } finally {
      setDeletingTag(null)
    }
  }

  const isPessoaTyped = newTagName.trim().toLowerCase() === 'pessoa'

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <h4 className="text-[11px] font-bold uppercase tracking-wider text-fg-subtle flex items-center gap-1.5">
          <Tag size={13} className="text-cyan-400" /> Tags do Lead
        </h4>
        {loading && <Loader2 size={12} className="animate-spin text-fg-muted" />}
      </div>

      {/* Lista de Tags */}
      <div className="flex flex-wrap gap-1.5">
        {tags.length === 0 && !loading && (
          <span className="text-micro text-fg-faint italic">Nenhuma tag atribuída</span>
        )}
        {tags.map((t) => {
          const isPessoa = t.tag === 'pessoa'
          const isDeleting = deletingTag === t.tag
          return (
            <span
              key={t.id || t.tag}
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
                onClick={() => handleDeleteTag(t.tag)}
                disabled={isDeleting}
                className="hover:text-rose-400 text-fg-subtle cursor-pointer ml-0.5"
                title="Remover tag"
              >
                {isDeleting ? <Loader2 size={10} className="animate-spin" /> : <X size={11} />}
              </button>
            </span>
          )
        })}
      </div>

      {/* Adicionar Tag */}
      <div className="space-y-2 pt-1 border-t border-line-subtle">
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            placeholder="Nova tag..."
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleAddTag()
              }
            }}
            className="h-8 text-micro bg-surface-inset border border-line-subtle rounded-md px-2 flex-1 text-fg placeholder:text-fg-faint focus:outline-none focus:border-cyan-500"
          />
          <Select
            value={newTagScope}
            onValueChange={(v) => v && setNewTagScope(v)}
            disabled={isPessoaTyped}
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
            onClick={handleAddTag}
            disabled={!newTagName.trim() || adding}
            className="h-8 px-2.5 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 rounded-md text-micro font-bold cursor-pointer"
          >
            {adding ? <Loader2 size={12} className="animate-spin" /> : <Plus size={13} />}
          </Button>
        </div>

        {isPessoaTyped && (
          <div className="p-2 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[11px] leading-tight">
            <span className="font-bold flex items-center gap-1"><AlertTriangle size={12} /> Tag pessoa:</span>
            Pausará o bot de IA e notificará a ponte externa. Escopo forçado para Geral.
          </div>
        )}

        {errorMsg && (
          <p className="text-[11px] text-rose-400 font-medium">{errorMsg}</p>
        )}
      </div>
    </div>
  )
}
