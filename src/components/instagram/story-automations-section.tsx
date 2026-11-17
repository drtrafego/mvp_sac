'use client'
/* eslint-disable @next/next/no-img-element -- URLs da Meta são temporárias e não pertencem ao loader local. */

import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'

export type StoryRule = { id: number; name: string; keywords: string[]; matchType: 'any' | 'contains' | 'exact'; storyId: string | null; dmMessage: string; mode: 'observe' | 'send'; isActive: boolean; enabledAt: string | null; createdAt: string }
type Rule = StoryRule
type Story = { id: string; media_url?: string; thumbnail_url?: string; timestamp?: string; permalink?: string }

const blank = { name: '', keywords: '', matchType: 'contains' as Rule['matchType'], storyId: null as string | null, dmMessage: '' }

export function StoryAutomationsSectionContent({ loading, loadError, onRetry, children }: { loading: boolean; loadError: string | null; onRetry: () => void; children: ReactNode }) {
  if (loading) return <section className="card bg-surface-raised border border-line-subtle p-5 rounded-2xl" aria-busy="true"><p className="text-sm text-fg-muted">Carregando automações de Story...</p></section>
  if (loadError) return <section className="card bg-surface-raised border border-line-subtle p-5 rounded-2xl space-y-3"><p className="text-sm text-red-400" role="alert">{loadError}</p><button onClick={onRetry} className="btn btn-primary text-xs px-3 py-2 rounded-xl">Tentar de novo</button></section>

  return <>{children}</>
}

export type StoryAutomationsSectionHandle = { openNew: () => void; edit: (rule: Rule) => void; toggle: (rule: Rule) => void; remove: (id: number) => void }

export function StoryAutomationsSection({ ref, onChanged }: { ref?: Ref<StoryAutomationsSectionHandle>; onChanged?: () => Promise<void> } = {}) {
  const [stories, setStories] = useState<Story[]>([])
  const [form, setForm] = useState(blank); const [editing, setEditing] = useState<number | null>(null); const [open, setOpen] = useState(false); const [error, setError] = useState<string | null>(null); const [loadingStories, setLoadingStories] = useState(false); const [saving, setSaving] = useState(false)
  const actionPending = useRef(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (open) nameRef.current?.focus()
  }, [open])
  useEffect(() => {
    if (!open && openerRef.current) {
      const target = openerRef.current.isConnected ? openerRef.current : document.querySelector<HTMLElement>('[aria-label="Resposta ao Story: criar nova regra"]')
      if (target) { target.focus(); openerRef.current = null }
    }
  }, [open])
  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (!saving) setOpen(false)
      return
    }
    if (event.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'))
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!first || !last) { event.preventDefault(); dialog.focus(); return }
    if (!dialog.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }
  }
  const load = async () => { await onChanged?.() }
  const showForm = async (rule?: Rule) => { openerRef.current = document.activeElement as HTMLElement | null; setError(null); setEditing(rule?.id ?? null); setForm(rule ? { name: rule.name, keywords: (rule.keywords ?? []).join(', '), matchType: rule.matchType, storyId: rule.storyId, dmMessage: rule.dmMessage } : blank); setOpen(true); setLoadingStories(true); try { const response = await fetch('/api/story-automations/stories', { cache: 'no-store' }); const data = await response.json().catch(() => ({})); if (response.ok) setStories(data.stories ?? []); else setError(data.error || 'Não foi possível carregar os Stories.') } catch { setError('Não foi possível carregar os Stories.') } finally { setLoadingStories(false) } }

  const save = async () => { if (saving) return; nameRef.current?.focus(); setSaving(true); setError(null); try { const response = await fetch(editing ? `/api/story-automations/${editing}` : '/api/story-automations', { method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, mode: 'send', isActive: true, keywords: form.keywords.split(',').map(word => word.trim()).filter(Boolean) }) }); const data = await response.json().catch(() => ({})); if (!response.ok) { setError(data.error || 'Não foi possível salvar.'); return }; setOpen(false); await load() } catch { setError('Não foi possível salvar a automação de Story.') } finally { setSaving(false) } }
  const mutate = async (id: number, method: 'PATCH' | 'DELETE', body?: { isActive: boolean }) => {
    if (actionPending.current) return
    actionPending.current = true
    setActionError(null)
    try {
      const response = await fetch(`/api/story-automations/${id}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      if (!response.ok) throw new Error('mutation')
      await load()
    } catch { setActionError('Não foi possível atualizar a regra de Story. Tente novamente.') }
    finally { actionPending.current = false }
  }
  const activate = (rule: Rule) => mutate(rule.id, 'PATCH', { isActive: !rule.isActive })
  const remove = async (id: number) => { if (window.confirm('Excluir esta regra de resposta ao Story?')) await mutate(id, 'DELETE') }
  useImperativeHandle(ref, () => ({ openNew: () => { void showForm() }, edit: rule => { void showForm(rule) }, toggle: rule => { void activate(rule) }, remove: id => { void remove(id) } }))
  return <>
    {actionError && <p role="alert" className="text-sm text-st-negativo">{actionError}</p>}
    {open && <div onMouseDown={event => { if (event.target === event.currentTarget) event.preventDefault() }} className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"><div role="dialog" aria-modal="true" aria-labelledby="story-rule-dialog-title" aria-describedby={error ? "story-rule-error" : undefined} ref={dialogRef} tabIndex={-1} onKeyDown={onDialogKeyDown} className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-surface-raised border border-line-subtle p-5 space-y-4"><div className="flex justify-between"><h3 id="story-rule-dialog-title" className="font-bold text-fg">{editing ? 'Editar regra de Story' : 'Nova regra de Story'}</h3><button onClick={() => { if (!saving) setOpen(false) }} className="text-fg-muted">Fechar</button></div>{error && <p id="story-rule-error" role="alert" className="text-xs text-st-negativo">{error}</p>}<label className="block text-xs text-fg-muted">Nome<input ref={nameRef} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} className="mt-1 w-full bg-surface-base border border-line-subtle rounded-lg p-2 text-fg" /></label><label className="block text-xs text-fg-muted">Resposta<select value={form.matchType} onChange={event => setForm({ ...form, matchType: event.target.value as Rule['matchType'] })} className="mt-1 w-full bg-surface-base border border-line-subtle rounded-lg p-2 text-fg"><option value="contains">Só se a pessoa escrever uma palavra</option><option value="exact">Mensagem exatamente igual à palavra</option><option value="any">Qualquer resposta, inclusive emoji</option></select></label>{form.matchType !== 'any' && <label className="block text-xs text-fg-muted">Palavras, separadas por vírgula<input value={form.keywords} onChange={event => setForm({ ...form, keywords: event.target.value })} className="mt-1 w-full bg-surface-base border border-line-subtle rounded-lg p-2 text-fg" placeholder="QUERO, LINK" /></label>}<fieldset className="text-xs text-fg-muted"><legend className="mb-1">Story</legend><label className="mr-4"><input type="radio" checked={!form.storyId} onChange={() => setForm({ ...form, storyId: null })} /> Todos os Stories</label><label><input type="radio" checked={!!form.storyId} onChange={() => setForm({ ...form, storyId: stories[0]?.id ?? '' })} disabled={!stories.length} /> Um Story específico</label>{form.storyId && <div className="mt-2 grid grid-cols-2 gap-2">{loadingStories ? <span>Carregando Stories...</span> : stories.map(story => <button key={story.id} onClick={() => setForm({ ...form, storyId: story.id })} className={`text-left border rounded-lg p-2 ${form.storyId === story.id ? 'border-pink-500' : 'border-line-subtle'}`}>{story.thumbnail_url || story.media_url ? <img src={story.thumbnail_url || story.media_url} alt="Miniatura do Story" className="w-full h-16 object-cover rounded" /> : null}<span className="block mt-1">{story.timestamp ? new Date(story.timestamp).toLocaleString('pt-BR') : `Story ${story.id.slice(-8)}`}</span></button>)}</div>}</fieldset><label className="block text-xs text-fg-muted">Mensagem do Direct<textarea value={form.dmMessage} onChange={event => setForm({ ...form, dmMessage: event.target.value })} maxLength={1000} className="mt-1 w-full bg-surface-base border border-line-subtle rounded-lg p-2 text-fg min-h-24" /></label><p className="text-xs text-amber-400">Ao salvar, a regra fica ativa e valendo. A Meta só lista Stories das últimas 24 horas. A DM vai apenas para quem responder por texto ou emoji e corresponder à regra. Curtidas com coração não geram DM.</p><div className="flex justify-end gap-2"><button onClick={() => { if (!saving) setOpen(false) }} className="text-xs px-3 py-2">Cancelar</button><button onClick={() => void save()} disabled={saving} className="btn btn-primary text-xs px-3 py-2 rounded-xl disabled:opacity-60">{saving ? 'Salvando...' : 'Salvar'}</button></div></div></div>}
  </>
}
