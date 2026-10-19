'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

type Template = { id: number; name: string; language: string; category: string; status: string; rejectionReason: string | null }
const example = JSON.stringify([{ type: 'BODY', text: 'Olá {{1}}, temos uma atualização para você.' }], null, 2)

export function TemplateManager() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [name, setName] = useState('')
  const [category, setCategory] = useState('UTILITY')
  const [components, setComponents] = useState(example)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function load() {
    const response = await fetch('/api/meta/templates/manage', { cache: 'no-store' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? 'Não foi possível carregar os templates.')
    setTemplates(data.templates)
  }

  async function create(submitImmediately: boolean) {
    let parsedComponents: unknown
    try { parsedComponents = JSON.parse(components) } catch { setMessage('Os componentes precisam estar em JSON válido.'); return }
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch('/api/meta/templates/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, language: 'pt_BR', category, components: parsedComponents }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? 'Não foi possível criar o template.')
      if (submitImmediately) {
        const submissionResponse = await fetch(`/api/meta/templates/manage/${data.template.id}/submit`, { method: 'POST' })
        const submission = await submissionResponse.json()
        if (!submissionResponse.ok) throw new Error(submission.error ?? 'Rascunho criado, mas não foi possível submetê-lo à Meta.')
        setMessage('Template enviado à Meta. Use sincronizar para confirmar o estado.')
      } else {
        setMessage('Rascunho criado. Revise e submeta à Meta quando estiver pronto.')
      }
      setName('')
      await load()
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Erro ao criar template.') } finally { setBusy(false) }
  }

  async function submit(id: number) {
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch(`/api/meta/templates/manage/${id}/submit`, { method: 'POST' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? 'Não foi possível submeter o template.')
      await load()
      setMessage('Template enviado à Meta. Use sincronizar para confirmar o estado.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Erro ao submeter template.') } finally { setBusy(false) }
  }

  async function sync() {
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch('/api/meta/templates/manage/sync', { method: 'POST' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? 'Não foi possível sincronizar.')
      await load()
      setMessage(`${data.synchronized} template(s) sincronizado(s).`)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Erro ao sincronizar.') } finally { setBusy(false) }
  }

  return <section className="card bg-surface-raised border border-line-subtle p-5 rounded-2xl space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-label font-semibold">Gerenciar templates</h2><p className="text-body text-fg-muted">Crie no SAC e envie direto para aprovação da Meta. Somente administradores podem criar, submeter ou sincronizar.</p></div>
      <div className="flex gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => { setBusy(true); void load().catch(error => setMessage(error.message)).finally(() => setBusy(false)) }}>Atualizar lista</Button><Button type="button" variant="outline" disabled={busy} onClick={() => void sync()}>Sincronizar estado da Meta</Button></div>
    </div>
    {message && <p role="status" className="text-body text-fg-muted">{message}</p>}
    <div className="grid gap-3 md:grid-cols-2"><div className="space-y-2"><Label htmlFor="template-name">Nome</Label><Input id="template-name" value={name} onChange={event => setName(event.target.value)} placeholder="lembrete_consulta" /></div><div className="space-y-2"><Label htmlFor="template-category">Categoria</Label><select id="template-category" className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" value={category} onChange={event => setCategory(event.target.value)}><option>UTILITY</option><option>MARKETING</option><option>AUTHENTICATION</option></select></div></div>
    <div className="space-y-2"><Label htmlFor="template-components">Componentes Meta, JSON</Label><Textarea id="template-components" value={components} onChange={event => setComponents(event.target.value)} className="min-h-36 font-mono text-xs" /></div>
    <div className="flex flex-wrap gap-2"><Button type="button" disabled={busy || !name.trim()} onClick={() => void create(true)}>Criar e submeter à Meta</Button><Button type="button" variant="outline" disabled={busy || !name.trim()} onClick={() => void create(false)}>Salvar rascunho</Button></div>
    <div className="space-y-2">{templates.length === 0 && <p className="text-body text-fg-muted">Nenhum rascunho ou estado sincronizado ainda.</p>}{templates.map(template => <div key={template.id} className="rounded-xl border border-line-subtle p-3 flex flex-wrap gap-3 items-center justify-between"><div><p className="font-mono text-sm font-semibold">{template.name} <span className="text-fg-muted">{template.language}</span></p><p className="text-xs text-fg-muted">{template.category} · {template.status}{template.rejectionReason ? ` · Motivo: ${template.rejectionReason}` : ''}</p></div>{(['DRAFT', 'REJECTED', 'FAILED'].includes(template.status)) && <Button type="button" variant="outline" disabled={busy} onClick={() => void submit(template.id)}>Submeter à Meta</Button>}</div>)}</div>
  </section>
}
