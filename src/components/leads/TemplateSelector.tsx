'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { MetaTemplate } from '@/lib/whatsapp/meta'
import { extractBodyPlaceholders, hasUnsupportedDynamicComponents, metaTemplateKey } from '@/lib/meta-template-utils'
import { SUPPORTED_VARIABLES, interpolateVariable } from '@/lib/lead-template-variables'

export type TemplateSelection = { templateName: string; templateLanguage: string; templateVariablesMap: Record<string, string> }

export function TemplateSelector({ lead, onChange }: { lead: Record<string, string>; onChange: (selection: TemplateSelection | null) => void }) {
  const [templates, setTemplates] = useState<MetaTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [language, setLanguage] = useState('')
  const [variablesMap, setVariablesMap] = useState<Record<string, string>>({})

  const load = async () => {
    setLoading(true); setError('')
    try {
      const response = await fetch('/api/meta/templates')
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Não foi possível carregar os templates aprovados.')
      setTemplates(Array.isArray(data) ? data : [])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Não foi possível carregar os templates aprovados.')
    } finally { setLoading(false) }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [])
  const selected = useMemo(() => templates.find(template => metaTemplateKey(template.name, template.language) === metaTemplateKey(name, language)) ?? null, [templates, name, language])
  const placeholders = useMemo(() => selected ? extractBodyPlaceholders(selected.components ?? []) : [], [selected])
  const unsupported = selected ? hasUnsupportedDynamicComponents(selected.components ?? []) : false
  const body = useMemo(() => {
    const component = selected?.components.find(value => value && typeof value === 'object' && !Array.isArray(value) && String((value as Record<string, unknown>).type ?? '').toUpperCase() === 'BODY') as Record<string, unknown> | undefined
    return typeof component?.text === 'string' ? component.text : ''
  }, [selected])
  const complete = placeholders.every(index => Boolean(variablesMap[String(index)]?.trim()))
  useEffect(() => {
    onChange(selected && complete && !unsupported ? { templateName: selected.name, templateLanguage: selected.language, templateVariablesMap: variablesMap } : null)
  }, [selected, complete, unsupported, variablesMap, onChange])
  const preview = body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, index: string) => {
    const source = variablesMap[index]
    return !source ? `{{${index}}}` : SUPPORTED_VARIABLES.some(variable => variable.token === source) ? interpolateVariable(source, lead) : source
  })

  if (loading) return <div className="p-5 text-center text-body text-fg-muted"><RefreshCw className="inline mr-2 animate-spin" size={15} />Carregando templates aprovados...</div>
  if (error) return <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-4 text-body text-rose-300"><p>{error}</p><Button variant="outline" className="mt-3" onClick={() => void load()}>Tentar novamente</Button></div>
  if (!templates.length) return <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-body text-amber-300">Não há templates aprovados disponíveis nesta conta Meta.</div>
  return <div className="space-y-4">
    <div className="space-y-1"><label className="text-micro font-bold text-fg">Template aprovado *</label>
      <Select value={selected ? metaTemplateKey(selected.name, selected.language) : '__none__'} onValueChange={value => { const template = templates.find(candidate => metaTemplateKey(candidate.name, candidate.language) === value); setName(template?.name ?? ''); setLanguage(template?.language ?? ''); setVariablesMap({}) }} items={{ __none__: 'Selecione o template...', ...Object.fromEntries(templates.map(template => [metaTemplateKey(template.name, template.language), `${template.name} (${template.language})`])) }}>
        <SelectTrigger className="bg-surface-inset border-line-subtle"><SelectValue placeholder="Selecione o template..." /></SelectTrigger><SelectContent className="bg-surface-overlay border-line-subtle"><SelectItem value="__none__">Selecione o template...</SelectItem>{templates.map(template => <SelectItem key={metaTemplateKey(template.name, template.language)} value={metaTemplateKey(template.name, template.language)}>{template.name} ({template.language})</SelectItem>)}</SelectContent>
      </Select>
    </div>
    {selected && <><div className="rounded-lg border border-line-subtle bg-surface-inset p-4"><p className="text-micro font-bold text-cyan-300">{selected.name} · {selected.language} · {selected.category}</p><p className="mt-2 whitespace-pre-wrap rounded bg-black/35 p-3 font-mono text-micro text-fg">{body || '(Template sem texto no BODY)'}</p></div>
      {unsupported ? <div className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-body text-amber-300"><AlertCircle size={16} />Este template usa HEADER de mídia ou componentes dinâmicos não suportados.</div> : placeholders.map(index => { const value = variablesMap[String(index)] ?? ''; const fixed = Boolean(value) && !SUPPORTED_VARIABLES.some(variable => variable.token === value); return <div key={index} className="grid gap-2 rounded-lg border border-line-subtle bg-surface-panel p-3 sm:grid-cols-2"><div className="space-y-1"><label className="text-micro font-bold text-fg">Variável {'{{'}{index}{'}}'} *</label><Select value={fixed ? '__fixed__' : value || '__none__'} onValueChange={nextValue => setVariablesMap(previous => { const next = { ...previous }; if (!nextValue || nextValue === '__none__') delete next[String(index)]; else next[String(index)] = nextValue === '__fixed__' ? ' ' : nextValue; return next })} items={{ __none__: 'Selecione a origem...', ...Object.fromEntries(SUPPORTED_VARIABLES.map(variable => [variable.token, variable.label])), __fixed__: 'Valor fixo' }}><SelectTrigger className="bg-surface-inset border-line-subtle"><SelectValue /></SelectTrigger><SelectContent className="bg-surface-overlay border-line-subtle"><SelectItem value="__none__">Selecione a origem...</SelectItem>{SUPPORTED_VARIABLES.map(variable => <SelectItem key={variable.token} value={variable.token}>{variable.label}</SelectItem>)}<SelectItem value="__fixed__">Valor fixo</SelectItem></SelectContent></Select></div>{fixed && <div className="space-y-1"><label className="text-micro font-bold text-fg">Valor fixo</label><Input value={value} onChange={event => setVariablesMap(previous => ({ ...previous, [String(index)]: event.target.value }))} className="bg-surface-inset border-line-subtle" /></div>}</div> })}
      <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3"><p className="text-micro font-bold text-cyan-300">Prévia com um lead selecionado</p><p className="mt-2 whitespace-pre-wrap text-body text-fg">{preview || '(sem conteúdo)'}</p></div>
    </>}
  </div>
}
