'use client'

import { useState, useEffect } from 'react'
import { Plus, Pencil, Trash2, LogIn, RefreshCw, Copy, Check, Link2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'

interface Company {
  id: number
  name: string
  slug: string
  plan: string
  stackAuthUserId: string | null
  inviteToken: string | null
  createdAt: string
}

const WEBHOOKS = [
  { key: 'hotmart', label: 'Hotmart', color: 'var(--plat-hotmart)' },
  { key: 'greenn', label: 'Greenn', color: 'var(--plat-greenn)' },
  { key: 'zouti', label: 'Zouti', color: 'var(--plat-zouti)' },
  { key: 'kiwify', label: 'Kiwify', color: 'var(--plat-kiwify)' },
] as const

// Ação de ícone: alvo de 44px abaixo de lg, 36px a partir de lg
const ICON_ACTION =
  'focus-ring inline-flex h-[var(--control-lg)] w-[var(--control-lg)] items-center justify-center rounded-[var(--r-sm)] text-fg-subtle transition-colors hover:bg-surface-inset hover:text-fg lg:h-[var(--control-md)] lg:w-[var(--control-md)]'

const FIELD =
  'focus-ring native-field h-[var(--control-lg)] w-full rounded-[var(--r-sm)] border border-line-default bg-surface-inset px-3 text-body text-fg placeholder:text-fg-faint lg:h-[var(--control-md)]'

const FIELD_LABEL = 'block text-label uppercase text-fg-subtle mb-1.5'

const PRIMARY_BUTTON =
  'focus-ring inline-flex h-[var(--control-lg)] items-center gap-2 rounded-[var(--r-sm)] bg-brand-solid px-3.5 text-body font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50 lg:h-[var(--control-md)]'

const GHOST_BUTTON =
  'focus-ring inline-flex h-[var(--control-lg)] items-center rounded-[var(--r-sm)] border border-line-default px-3.5 text-body font-medium text-fg-muted transition-colors hover:text-fg lg:h-[var(--control-md)]'

export default function EmpresasPage() {
  const [companies, setCompanies] = useState<Company[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [entering, setEntering] = useState<number | null>(null)
  // Uma chave por botão de cópia: convite e as quatro URLs de webhook
  const [copied, setCopied] = useState<string | null>(null)
  const router = useRouter()

  async function loadCompanies() {
    setLoading(true)
    const res = await fetch('/api/admin/companies')
    const data = await res.json()
    setCompanies(data)
    setLoading(false)
  }

  useEffect(() => { loadCompanies() }, [])

  async function handleEnter(companyId: number) {
    setEntering(companyId)
    await fetch(`/api/admin/companies/${companyId}/enter`, { method: 'POST' })
    router.push('/')
    router.refresh()
  }

  async function handleDelete(companyId: number, name: string) {
    if (!confirm(`Excluir empresa "${name}"? Todos os dados serão removidos.`)) return
    await fetch(`/api/admin/companies/${companyId}`, { method: 'DELETE' })
    loadCompanies()
  }

  async function handleRegenerateToken(companyId: number) {
    await fetch(`/api/admin/companies/${companyId}`, { method: 'PUT' })
    loadCompanies()
  }

  function copyText(key: string, text: string) {
    navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 2000)
  }

  function copyInviteLink(company: Company) {
    if (!company.inviteToken) return
    copyText(`invite-${company.id}`, `${window.location.origin}/invite/${company.inviteToken}`)
  }

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-start justify-between gap-4 rise rise-1">
        <div>
          <h1 className="text-h1 text-fg">Empresas</h1>
          <p className="text-body text-fg-muted mt-1">Gerencie todas as empresas do sistema</p>
        </div>
        <button onClick={() => setShowCreate(true)} className={PRIMARY_BUTTON}>
          <Plus size={16} />
          Nova empresa
        </button>
      </div>

      {showCreate && (
        <CreateCompanyForm
          onCreated={() => { setShowCreate(false); loadCompanies() }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton h-32" />)}
        </div>
      ) : (
        <div className="space-y-3 rise rise-2">
          {companies.map(company => (
            <div key={company.id}>
              {editingId === company.id ? (
                <EditCompanyForm
                  company={company}
                  onSaved={() => { setEditingId(null); loadCompanies() }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <div className="card p-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <h2 className="text-h2 text-fg">{company.name}</h2>
                        <span className="num text-micro text-fg-subtle">/{company.slug}</span>
                        <span className="text-label uppercase text-fg-faint">{company.plan}</span>
                      </div>

                      <ul className="mt-3 space-y-1">
                        {WEBHOOKS.map(({ key, label, color }) => {
                          const path = `/api/webhooks/${key}/${company.slug}`
                          const copyKey = `wh-${company.id}-${key}`
                          return (
                            <li key={key} className="flex items-center gap-2">
                              <span className="dot" style={{ color }} />
                              <span className="w-16 shrink-0 text-micro text-fg-subtle">{label}</span>
                              <span className="num min-w-0 flex-1 truncate text-micro text-fg-muted" title={path}>
                                {path}
                              </span>
                              <button
                                onClick={() => copyText(copyKey, `${window.location.origin}${path}`)}
                                aria-label={`Copiar URL do webhook ${label}`}
                                className="focus-ring inline-flex h-[var(--control-lg)] w-[var(--control-lg)] shrink-0 items-center justify-center rounded-[var(--r-sm)] text-fg-subtle transition-colors hover:bg-surface-inset hover:text-fg lg:h-8 lg:w-8"
                              >
                                {copied === copyKey
                                  ? <Check size={14} className="text-st-positivo" />
                                  : <Copy size={14} />}
                              </button>
                            </li>
                          )
                        })}
                      </ul>

                      <div className="mt-3 text-micro">
                        {company.stackAuthUserId ? (
                          <span className="text-fg-subtle">
                            User ID: <span className="num text-fg-muted">{company.stackAuthUserId}</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-fg-muted">
                            <span className="dot" style={{ color: 'var(--st-atencao)' }} />
                            Sem usuário vinculado
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                      <button
                        title="Copiar link de convite"
                        aria-label="Copiar link de convite"
                        onClick={() => copyInviteLink(company)}
                        className={ICON_ACTION}
                      >
                        {copied === `invite-${company.id}`
                          ? <Check size={15} className="text-st-positivo" />
                          : <Link2 size={15} />}
                      </button>
                      <button
                        title="Regenerar token de convite"
                        aria-label="Regenerar token de convite"
                        onClick={() => handleRegenerateToken(company.id)}
                        className={ICON_ACTION}
                      >
                        <RefreshCw size={15} />
                      </button>
                      <button
                        title="Editar empresa"
                        aria-label="Editar empresa"
                        onClick={() => setEditingId(company.id)}
                        className={ICON_ACTION}
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        title="Excluir empresa"
                        aria-label="Excluir empresa"
                        onClick={() => handleDelete(company.id, company.name)}
                        className={cn(ICON_ACTION, 'text-st-negativo hover:text-st-negativo')}
                      >
                        <Trash2 size={15} />
                      </button>
                      <button
                        onClick={() => handleEnter(company.id)}
                        disabled={entering === company.id}
                        className={`${PRIMARY_BUTTON} ml-1`}
                      >
                        <LogIn size={14} />
                        {entering === company.id ? 'Entrando...' : 'Entrar'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
          {companies.length === 0 && (
            <div className="card px-5 py-12 text-center text-body text-fg-subtle">
              Nenhuma empresa cadastrada.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function CreateCompanyForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [plan, setPlan] = useState('free')
  const [saving, setSaving] = useState(false)

  function handleNameChange(v: string) {
    setName(v)
    setSlug(v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const res = await fetch('/api/admin/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, slug, plan }),
    })
    if (res.ok) onCreated()
    else setSaving(false)
  }

  return (
    <form onSubmit={handleSubmit} className="card-section space-y-4 p-5">
      <h2 className="text-h2 text-fg">Nova empresa</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={FIELD_LABEL}>Nome</label>
          <input value={name} onChange={e => handleNameChange(e.target.value)} className={FIELD} required />
        </div>
        <div>
          <label className={FIELD_LABEL}>Slug (URL)</label>
          <input value={slug} onChange={e => setSlug(e.target.value)} className={`${FIELD} num`} required />
        </div>
      </div>
      <div className="max-w-[var(--w-form)]">
        <label className={FIELD_LABEL}>Plano</label>
        <select value={plan} onChange={e => setPlan(e.target.value)} className={FIELD}>
          <option value="free">Free</option>
          <option value="pro">Pro</option>
          <option value="enterprise">Enterprise</option>
        </select>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className={PRIMARY_BUTTON}>
          {saving ? 'Criando...' : 'Criar empresa'}
        </button>
        <button type="button" onClick={onCancel} className={GHOST_BUTTON}>Cancelar</button>
      </div>
    </form>
  )
}

function EditCompanyForm({ company, onSaved, onCancel }: { company: Company; onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState(company.name)
  const [slug, setSlug] = useState(company.slug)
  const [plan, setPlan] = useState(company.plan || 'free')
  const [userId, setUserId] = useState(company.stackAuthUserId || '')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const res = await fetch(`/api/admin/companies/${company.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, slug, plan, stackAuthUserId: userId || null }),
    })
    if (res.ok) onSaved()
    else setSaving(false)
  }

  return (
    <form onSubmit={handleSubmit} className="card-section space-y-4 p-5">
      <h2 className="inline-flex items-center gap-2 text-h2 text-fg">
        <span className="dot" style={{ color: 'var(--st-atencao)' }} />
        Editando: {company.name}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={FIELD_LABEL}>Nome</label>
          <input value={name} onChange={e => setName(e.target.value)} className={FIELD} required />
        </div>
        <div>
          <label className={FIELD_LABEL}>Slug</label>
          <input value={slug} onChange={e => setSlug(e.target.value)} className={`${FIELD} num`} required />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={FIELD_LABEL}>Plano</label>
          <select value={plan} onChange={e => setPlan(e.target.value)} className={FIELD}>
            <option value="free">Free</option>
            <option value="pro">Pro</option>
            <option value="enterprise">Enterprise</option>
          </select>
        </div>
        <div>
          <label className={FIELD_LABEL}>Stack Auth User ID</label>
          <input
            value={userId}
            onChange={e => setUserId(e.target.value)}
            placeholder="Vazio = sem usuário"
            className={`${FIELD} num`}
          />
        </div>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className={PRIMARY_BUTTON}>
          {saving ? 'Salvando...' : 'Salvar'}
        </button>
        <button type="button" onClick={onCancel} className={GHOST_BUTTON}>Cancelar</button>
      </div>
    </form>
  )
}
