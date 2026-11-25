'use client'

import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SUPPORTED_VARIABLES, isSupportedVariableSource, templateVariableLabel, templateVariableMapKey } from '@/lib/lead-template-variables'

export function TemplateVariableMapping({
  variables,
  values,
  onChange,
  preview,
  idPrefix,
}: {
  variables: string[]
  values: Record<string, string>
  onChange: (values: Record<string, string>) => void
  preview: string
  idPrefix: string
}) {
  return <div className="space-y-3">
    {variables.map(variable => {
      const key = templateVariableMapKey(variable)
      const value = values[key] ?? ''
      const fixed = Boolean(value) && !isSupportedVariableSource(value)
      const fieldId = `${idPrefix}-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`
      return <div key={variable} className="grid gap-2 rounded-lg border border-line-subtle bg-surface-panel p-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-micro font-bold text-fg" htmlFor={`${fieldId}-source`}>{templateVariableLabel(variable)} *</label>
          <Select
            value={fixed ? '__fixed__' : value || '__none__'}
            onValueChange={nextValue => {
              const next = { ...values }
              if (!nextValue || nextValue === '__none__') delete next[key]
              else next[key] = nextValue === '__fixed__' ? ' ' : nextValue
              onChange(next)
            }}
            items={{ __none__: 'Selecione a origem...', ...Object.fromEntries(SUPPORTED_VARIABLES.map(source => [source.token, source.label])), __fixed__: 'Valor fixo' }}
          >
            <SelectTrigger id={`${fieldId}-source`} className="bg-surface-inset border-line-subtle"><SelectValue /></SelectTrigger>
            <SelectContent className="bg-surface-overlay border-line-subtle">
              <SelectItem value="__none__">Selecione a origem...</SelectItem>
              {SUPPORTED_VARIABLES.map(source => <SelectItem key={source.token} value={source.token}>{source.label}</SelectItem>)}
              <SelectItem value="__fixed__">Valor fixo</SelectItem>
            </SelectContent>
          </Select>
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
