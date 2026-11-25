'use client'

import { useId, useState } from 'react'
import { Check, ChevronDown, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface LeadFilterOption {
  value: string
  label: string
}

interface LeadFilterMultiSelectProps {
  label: string
  placeholder: string
  options: LeadFilterOption[]
  values: string[]
  onChange: (values: string[]) => void
  emptyLabel?: string
}

export function LeadFilterMultiSelect({
  label,
  placeholder,
  options,
  values,
  onChange,
  emptyLabel = 'Nenhum dado disponível para este cliente',
}: LeadFilterMultiSelectProps) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const selected = new Set(values)

  function toggle(value: string) {
    onChange(selected.has(value) ? values.filter(current => current !== value) : [...values, value])
  }

  return (
    <div className="relative min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen(current => !current)}
        className="flex min-h-10 w-full items-center justify-between gap-2 rounded-lg border border-line-subtle bg-surface-inset px-3 text-left text-micro text-fg transition-colors hover:border-line-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-solid/40"
      >
        <span className="min-w-0">
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">{label}</span>
          <span className="block truncate text-fg">
            {values.length === 0 ? placeholder : `${values.length} selecionado${values.length === 1 ? '' : 's'}`}
          </span>
        </span>
        <ChevronDown size={15} className={cn('shrink-0 text-fg-subtle transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div id={menuId} role="group" aria-label={label} className="absolute z-40 mt-1 max-h-72 w-full min-w-[220px] overflow-y-auto rounded-xl border border-line-subtle bg-surface-overlay p-1.5 shadow-xl">
          {options.length === 0 ? (
            <p className="px-2.5 py-3 text-[11px] text-fg-subtle">{emptyLabel}</p>
          ) : (
            options.map(option => {
              const checked = selected.has(option.value)
              return (
                <label key={option.value} className="flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-micro text-fg hover:bg-surface-raised">
                  <span className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border', checked ? 'border-brand-solid bg-brand-solid text-on-accent' : 'border-line-default bg-surface-inset')}>
                    {checked && <Check size={11} strokeWidth={3} />}
                  </span>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(option.value)}
                    className="sr-only"
                  />
                  <span className="min-w-0 break-words">{option.label}</span>
                </label>
              )
            })
          )}
          {values.length > 0 && (
            <button type="button" onClick={() => onChange([])} className="mt-1 flex w-full items-center gap-1.5 border-t border-line-subtle px-2.5 py-2 text-left text-[11px] font-semibold text-fg-subtle hover:text-fg">
              <X size={12} /> Limpar {label.toLowerCase()}
            </button>
          )}
        </div>
      )}

      {values.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1" aria-label={`${label} selecionados`}>
          {values.map(value => {
            const option = options.find(item => item.value === value)
            return (
              <button
                key={value}
                type="button"
                onClick={() => toggle(value)}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-brand-solid/30 bg-brand-glow px-2 py-1 text-[10px] font-semibold text-brand-ink hover:border-brand-solid/60"
                title="Remover filtro"
              >
                <span className="max-w-[150px] truncate">{option?.label ?? value}</span>
                <X size={11} className="shrink-0" />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
