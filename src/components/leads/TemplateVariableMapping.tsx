'use client'

import { Input } from '@/components/ui/input'
import { SUPPORTED_VARIABLES, isSupportedVariableSource, templateVariableLabel, templateVariableMapKey } from '@/lib/lead-template-variables'

export function TemplateVariableMapping({
  variables,
  values,
  onChange,
  preview,
  idPrefix,
  sources = SUPPORTED_VARIABLES,
}: {
  variables: string[]
  values: Record<string, string>
  onChange: (values: Record<string, string>) => void
  preview: string
  idPrefix: string
  sources?: readonly { token: string; label: string }[]
}) {
  return <div className="space-y-3">
    <p className="text-micro text-fg-muted">Preencher com: escolha um campo real do destinatário ou informe um valor fixo para cada posição.</p>
    {variables.map(variable => {
      const key = templateVariableMapKey(variable)
      const value = values[key] ?? ''
      const fixed = Boolean(value) && !isSupportedVariableSource(value)
      const fieldId = `${idPrefix}-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`
      return <div key={variable} className="grid gap-2 rounded-lg border border-line-subtle bg-surface-panel p-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-micro font-bold text-fg" htmlFor={`${fieldId}-source`}>{templateVariableLabel(variable)} *</label>
          <select
            id={`${fieldId}-source`}
            value={fixed ? '__fixed__' : value || '__none__'}
            onChange={event => {
              const next = { ...values }
              const nextValue = event.target.value
              if (!nextValue || nextValue === '__none__') delete next[key]
              else next[key] = nextValue === '__fixed__' ? ' ' : nextValue
              onChange(next)
            }}
            className="flex h-10 w-full min-w-0 rounded-md border border-line-subtle bg-surface-inset px-3 text-body text-fg outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30"
          >
            <option value="__none__">Selecione a origem...</option>
            {sources.map(source => <option key={source.token} value={source.token}>{source.label}</option>)}
            <option value="__fixed__">Valor fixo</option>
          </select>
        </div>
        {fixed && <div className="space-y-1">
          <label className="text-micro font-bold text-fg" htmlFor={`${fieldId}-fixed`}>Valor fixo</label>
          <Input id={`${fieldId}-fixed`} value={value.trim()} onChange={event => onChange({ ...values, [key]: event.target.value })} className="bg-surface-inset border-line-subtle" />
        </div>}
      </div>
    })}
    <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3">
      <p className="text-micro font-bold text-cyan-300">Prévia atualizada</p>
      <p className="mt-2 whitespace-pre-wrap text-body text-fg">{preview || '(sem conteúdo)'}</p>
    </div>
  </div>
}
