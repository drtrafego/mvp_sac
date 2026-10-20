'use client'

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  formToMetaTemplateComponents,
  type MetaButtonType,
  type MetaHeaderType,
  type MetaTemplateFormButton,
} from '@/lib/meta-template-form'

type Template = { id: number; name: string; language: string; category: string; status: string; rejectionReason: string | null }

const emptyButton = (): MetaTemplateFormButton => ({ type: 'QUICK_REPLY', text: '', value: '' })

export function TemplateManager() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [name, setName] = useState('')
  const [category, setCategory] = useState('UTILITY')
  const [language, setLanguage] = useState('pt_BR')
  const [body, setBody] = useState('')
  const [bodyExamples, setBodyExamples] = useState('')
  const [headerType, setHeaderType] = useState<MetaHeaderType>('none')
  const [headerText, setHeaderText] = useState('')
  const [headerExample, setHeaderExample] = useState('')
  const [footer, setFooter] = useState('')
  const [buttons, setButtons] = useState<MetaTemplateFormButton[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function load() {
    const response = await fetch('/api/meta/templates/manage', { cache: 'no-store' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? 'Não foi possível carregar os templates.')
    setTemplates(data.templates)
  }

  function updateButton(index: number, patch: Partial<MetaTemplateFormButton>) {
    setButtons(current => current.map((button, currentIndex) => currentIndex === index ? { ...button, ...patch } : button))
  }

  function resetForm() {
    setName('')
    setBody('')
    setBodyExamples('')
    setHeaderType('none')
    setHeaderText('')
    setHeaderExample('')
    setFooter('')
    setButtons([])
  }

  async function create(submitImmediately: boolean) {
    let components: unknown[]
    try {
      components = formToMetaTemplateComponents({ body, bodyExamples, headerType, headerText, headerExample, footer, buttons })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Revise os campos do template.')
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch('/api/meta/templates/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, language, category, components }),
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
      resetForm()
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

  return <section className="card bg-surface-raised border border-line-subtle p-5 rounded-2xl space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-label font-semibold">Criar template Meta</h2><p className="text-body text-fg-muted">Preencha a mensagem como no Gerenciador do WhatsApp. O SAC monta o formato técnico automaticamente.</p></div>
      <div className="flex gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => { setBusy(true); void load().catch(error => setMessage(error.message)).finally(() => setBusy(false)) }}>Atualizar lista</Button><Button type="button" variant="outline" disabled={busy} onClick={() => void sync()}>Sincronizar estado da Meta</Button></div>
    </div>
    {message && <p role="status" className="rounded-lg bg-surface-inset px-3 py-2 text-body text-fg-muted">{message}</p>}

    <div className="grid gap-4 md:grid-cols-3">
      <div className="space-y-2"><Label htmlFor="template-name">Nome do template</Label><Input id="template-name" value={name} onChange={event => setName(event.target.value)} placeholder="lembrete_consulta" /></div>
      <div className="space-y-2"><Label htmlFor="template-category">Categoria</Label><select id="template-category" className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" value={category} onChange={event => setCategory(event.target.value)}><option value="UTILITY">Utilidade</option><option value="MARKETING">Marketing</option><option value="AUTHENTICATION">Autenticação</option></select></div>
      <div className="space-y-2"><Label htmlFor="template-language">Idioma</Label><select id="template-language" className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" value={language} onChange={event => setLanguage(event.target.value)}><option value="pt_BR">Português, Brasil</option><option value="en_US">English, US</option><option value="es_ES">Español, España</option></select></div>
    </div>

    <fieldset className="rounded-xl border border-line-subtle p-4 space-y-4">
      <legend className="px-1 text-sm font-semibold">Cabeçalho, opcional</legend>
      <div className="grid gap-3 md:grid-cols-2"><div className="space-y-2"><Label htmlFor="header-type">Tipo</Label><select id="header-type" className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" value={headerType} onChange={event => setHeaderType(event.target.value as MetaHeaderType)}><option value="none">Sem cabeçalho</option><option value="text">Texto</option><option value="image">Imagem</option><option value="video">Vídeo</option><option value="document">Documento</option></select></div>
      {headerType === 'text' && <div className="space-y-2"><Label htmlFor="header-text">Texto do cabeçalho</Label><Input id="header-text" value={headerText} onChange={event => setHeaderText(event.target.value)} maxLength={60} placeholder="Olá, {{1}}" /></div>}
      {headerType !== 'none' && <div className="space-y-2"><Label htmlFor="header-example">{headerType === 'text' ? 'Exemplo das variáveis, separado por vírgula' : 'Identificador de mídia de exemplo da Meta'}</Label><Input id="header-example" value={headerExample} onChange={event => setHeaderExample(event.target.value)} placeholder={headerType === 'text' ? 'Gastão' : 'handle recebido no upload da Meta'} /></div>}</div>
    </fieldset>

    <fieldset className="rounded-xl border border-line-subtle p-4 space-y-3">
      <legend className="px-1 text-sm font-semibold">Corpo da mensagem</legend>
      <div className="space-y-2"><Label htmlFor="template-body">Mensagem</Label><Textarea id="template-body" value={body} onChange={event => setBody(event.target.value)} maxLength={1024} className="min-h-32" placeholder="Olá, {{1}}. Seu atendimento está confirmado para {{2}}." /></div>
      <div className="space-y-2"><Label htmlFor="body-examples">Exemplos das variáveis</Label><Input id="body-examples" value={bodyExamples} onChange={event => setBodyExamples(event.target.value)} placeholder="Gastão, terça-feira às 14h" /><p className="text-xs text-fg-muted">Use vírgula, ponto e vírgula ou uma linha para separar os exemplos na ordem de cada {'{{variável}}'}.</p></div>
    </fieldset>

    <fieldset className="rounded-xl border border-line-subtle p-4 space-y-3">
      <legend className="px-1 text-sm font-semibold">Rodapé, opcional</legend>
      <div className="space-y-2"><Label htmlFor="template-footer">Texto do rodapé</Label><Input id="template-footer" value={footer} onChange={event => setFooter(event.target.value)} maxLength={60} placeholder="Não responda a esta mensagem." /></div>
    </fieldset>

    <fieldset className="rounded-xl border border-line-subtle p-4 space-y-3">
      <div className="flex items-center justify-between gap-3"><legend className="px-1 text-sm font-semibold">Botões, opcional</legend><Button type="button" variant="outline" size="sm" disabled={busy || buttons.length >= 3} onClick={() => setButtons(current => [...current, emptyButton()])}><Plus size={15} />Adicionar botão</Button></div>
      {buttons.length === 0 && <p className="text-sm text-fg-muted">Você pode adicionar até três respostas rápidas, links ou telefones.</p>}
      {buttons.map((button, index) => <div key={index} className="grid gap-3 rounded-lg bg-surface-inset p-3 md:grid-cols-[150px_1fr_1fr_auto]">
        <div className="space-y-1"><Label htmlFor={`button-type-${index}`}>Tipo</Label><select id={`button-type-${index}`} className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" value={button.type} onChange={event => updateButton(index, { type: event.target.value as MetaButtonType, value: '' })}><option value="QUICK_REPLY">Resposta rápida</option><option value="URL">Link</option><option value="PHONE_NUMBER">Telefone</option></select></div>
        <div className="space-y-1"><Label htmlFor={`button-text-${index}`}>Texto</Label><Input id={`button-text-${index}`} value={button.text} onChange={event => updateButton(index, { text: event.target.value })} maxLength={20} placeholder="Falar com equipe" /></div>
        {button.type !== 'QUICK_REPLY' && <div className="space-y-1"><Label htmlFor={`button-value-${index}`}>{button.type === 'URL' ? 'URL' : 'Telefone'}</Label><Input id={`button-value-${index}`} value={button.value} onChange={event => updateButton(index, { value: event.target.value })} placeholder={button.type === 'URL' ? 'https://exemplo.com' : '+5511999999999'} /></div>}
        {button.type === 'QUICK_REPLY' && <div />}
        <Button type="button" variant="ghost" size="icon" className="self-end" aria-label={`Remover botão ${index + 1}`} onClick={() => setButtons(current => current.filter((_, currentIndex) => currentIndex !== index))}><Trash2 size={16} /></Button>
      </div>)}
    </fieldset>

    <div className="flex flex-wrap gap-2"><Button type="button" disabled={busy || !name.trim() || !body.trim()} onClick={() => void create(true)}>Criar e submeter à Meta</Button><Button type="button" variant="outline" disabled={busy || !name.trim() || !body.trim()} onClick={() => void create(false)}>Salvar rascunho</Button></div>
    <div className="space-y-2">{templates.length === 0 && <p className="text-body text-fg-muted">Nenhum rascunho ou estado sincronizado ainda.</p>}{templates.map(template => <div key={template.id} className="rounded-xl border border-line-subtle p-3 flex flex-wrap gap-3 items-center justify-between"><div><p className="font-mono text-sm font-semibold">{template.name} <span className="text-fg-muted">{template.language}</span></p><p className="text-xs text-fg-muted">{template.category} · {template.status}{template.rejectionReason ? ` · Motivo: ${template.rejectionReason}` : ''}</p></div>{(['DRAFT', 'REJECTED', 'FAILED'].includes(template.status)) && <Button type="button" variant="outline" disabled={busy} onClick={() => void submit(template.id)}>Submeter à Meta</Button>}</div>)}</div>
  </section>
}
