'use client'

import { useState } from 'react'
import { Plus, Tag, X } from 'lucide-react'
import { normalizeTag, MAX_TAG_LENGTH } from '@/lib/lead-tags'

interface LeadTagsFieldProps {
  value: string[]
  onChange: (tags: string[]) => void
  id?: string
  disabled?: boolean
}

/**
 * Editor controlado de tags usado nos formulários de lead.
 * A normalização e o limite seguem o mesmo contrato das rotas canônicas de tags.
 */
export function LeadTagsField({ value, onChange, id = 'lead-tags', disabled = false }: LeadTagsFieldProps) {
  const [draft, setDraft] = useState('')
  const tags = [...new Set(value.map(normalizeTag).filter(Boolean))]

  function addTag(raw: string) {
    const tag = normalizeTag(raw)
    if (!tag || tags.includes(tag)) {
      setDraft('')
      return
    }
    onChange([...tags, tag])
    setDraft('')
  }

  return (
    <section className="rounded-xl border border-line-subtle bg-surface-panel p-3.5 sm:p-4 space-y-2.5">
      <div className="space-y-0.5">
        <label htmlFor={id} className="text-micro font-semibold text-fg flex items-center gap-1.5">
          <Tag size={13} className="text-amber-400" /> Tags
        </label>
        <p className="text-[11px] text-fg-subtle">Use tags para organizar o contato. Adicione uma existente ou crie outra.</p>
      </div>

      <div className="flex flex-wrap gap-1.5" aria-live="polite">
        {tags.length === 0 && <span className="text-[11px] text-fg-faint">Nenhuma tag selecionada</span>}
        {tags.map(tag => (
          <span key={tag} className="inline-flex min-h-7 items-center gap-1 rounded-full border border-brand-solid/30 bg-brand-glow px-2 py-1 text-[11px] font-semibold text-brand-ink">
            {tag}
            <button
              type="button"
              onClick={() => onChange(tags.filter(current => current !== tag))}
              disabled={disabled}
              aria-label={`Remover tag ${tag}`}
              className="inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10 disabled:opacity-40"
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <input
          id={id}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault()
              addTag(draft)
            }
          }}
          maxLength={MAX_TAG_LENGTH}
          placeholder="Digite uma tag e pressione Enter"
          disabled={disabled}
          className="focus-ring min-h-11 min-w-0 flex-1 rounded-lg border border-line-subtle bg-surface-inset px-3 text-sm text-fg placeholder:text-fg-faint disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => addTag(draft)}
          disabled={disabled || !draft.trim()}
          aria-label="Adicionar tag"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-line-subtle bg-surface-inset text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg disabled:opacity-40"
        >
          <Plus size={16} />
        </button>
      </div>
      <p className="text-[11px] text-fg-subtle">As tags existentes aparecem acima; novas tags são normalizadas e podem ter até 50 caracteres.</p>
    </section>
  )
}
