'use client'

import { useState, useEffect } from 'react'
import { Plus, Pencil, Trash2, LogIn, RefreshCw, Copy, Check, Link2, Bot, Database, Sparkles, CheckCircle2, AlertCircle, ChevronRight } from 'lucide-react'
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
  sidebarConfig?: any
}

const WEBHOOKS = [
  { key: 'hotmart', label: 'Hotmart', color: 'var(--plat-hotmart)' },
  { key: 'greenn', label: 'Greenn', color: 'var(--plat-greenn)' },
  { key: 'zouti', label: 'Zouti', color: 'var(--plat-zouti)' },
  { key: 'kiwify', label: 'Kiwify', color: 'var(--plat-kiwify)' },
] as const

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
  const [copied, setCopied] = useState<string | null>(null)

  // Supabase Hub state
  const [supabaseUrlInput, setSupabaseUrlInput] = useState('')
  const [supabaseStatus, setSupabaseStatus] = useState<{ configured: boolean; hasEnv: boolean; url: string | null } | null>(null)
  const [showUrlField, setShowUrlField] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncReport, setSyncReport] = useState<any | null>(null)
  const router = useRouter()

  async function loadCompanies() {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/companies')
      const data = await res.json()
      if (Array.isArray(data)) setCompanies(data)
    } finally {
      setLoading(false)
    }
  }

  async function loadSupabaseStatus() {
    try {
      const res = await fetch('/api/admin/sync-agents')
      const data = await res.json()
      setSupabaseStatus(data)
      if (data.url && !supabaseUrlInput) {
        setSupabaseUrlInput(data.url)
      }
    } catch {}
  }

  async function handleSyncAgents() {
    setSyncing(true)
    setSyncReport(null)
    try {
      const res = await fetch('/api/admin/sync-agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supabaseUrl: supabaseUrlInput.trim() || undefined,
        }),
      })
      const data = await res.json()
      setSyncReport(data)
      loadCompanies()
      loadSupabaseStatus()
    } catch (err: any) {
      setSyncReport({
        ok: false,
        message: 'Erro de conexão ao sincronizar agentes.',
        details: [String(err?.message || err)],
      })
    } finally {
      setSyncing(false)
    }
  }

  useEffect(() => {
    loadCompanies()
    loadSupabaseStatus()
  }, [])

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
    <div className="max-w-4xl space-y-5">
      {/* Cabeçalho */}
      <div className="flex flex-wrap items-center justify-between gap-4 rise rise-1">
        <div>
          <h1 className="text-h1 text-fg">Central de Agentes & Empresas</h1>
          <p className="text-body text-fg-muted mt-1">
            Gerencie os workspaces dos 3 agentes (Gastão Matos, Gramado Plaza, Dr. Lucas) ou conecte via Supabase.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowCreate(true)} className={PRIMARY_BUTTON}>
            <Plus size={16} />
            Nova empresa
          </button>
        </div>
      </div>

      {/* Card Principal: Hub de Sincronização Supabase */}
      <div className="rounded-2xl border border-brand-solid/30 bg-surface-panel p-5 shadow-xs space-y-4 rise rise-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-brand-glow border border-brand-solid/30 flex items-center justify-center text-brand-ink shrink-0">
              <Database size={20} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-h3 text-fg font-bold">Integração Central Supabase</h2>
                <span className={cn(
                  'text-[10px] font-bold px-2 py-0.5 rounded-full border',
                  supabaseStatus?.configured
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                    : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                )}>
                  {supabaseStatus?.configured ? 'Conectado' : 'Aguardando Configuração'}
                </span>
              </div>
              <p className="text-micro text-fg-subtle mt-0.5">
                Importa automaticamente os 3 bots (Gastão Matos, Gramado Plaza, Dr. Lucas), seus leads de CRM e conversas.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSyncAgents}
              disabled={syncing}
              className="focus-ring inline-flex h-10 items-center gap-2 rounded-xl bg-brand-solid px-4 text-xs font-bold text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50 cursor-pointer shadow-sm"
            >
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
              <span>{syncing ? 'Sincronizando do Supabase...' : 'Sincronizar Agentes & CRM'}</span>
            </button>
            <button
              type="button"
              onClick={() => setShowUrlField(!showUrlField)}
              className="text-xs font-semibold text-brand-ink hover:underline px-2 py-1"
            >
              {showUrlField ? 'Ocultar URL' : 'Configurar URL'}
            </button>
          </div>
        </div>

        {/* Campo opcional para colar a URL do Supabase */}
        {showUrlField && (
          <div className="p-3.5 rounded-xl bg-surface-inset border border-line-subtle space-y-2 text-micro">
            <label className="font-semibold text-fg block">
              String de Conexão Supabase (Porta 6543 / Transaction Mode):
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={supabaseUrlInput}
                onChange={(e) => setSupabaseUrlInput(e.target.value)}
                placeholder="postgresql://postgres.[ref]:[senha]@aws-0-[region].pooler.supabase.com:6543/postgres"
                className="flex-1 h-9 px-3 rounded-lg bg-surface-panel border border-line-subtle text-fg text-xs font-mono placeholder:text-fg-faint"
              />
              <button
                type="button"
                onClick={handleSyncAgents}
                disabled={syncing || !supabaseUrlInput.trim()}
                className="h-9 px-3 bg-surface-panel hover:bg-surface-raised border border-brand-solid/40 text-brand-ink rounded-lg font-bold text-xs cursor-pointer"
              >
                Salvar & Sincronizar
              </button>
            </div>
            <p className="text-[11px] text-fg-subtle">
              Dica: Copie a URL Transaction Mode do Supabase (porta 6543) para multiplexar conexões sem exceder o limite do pooler.
            </p>
          </div>
        )}

        {/* Feedback da sincronização */}
        {syncReport && (
          <div className={cn(
            'p-4 rounded-xl border text-micro space-y-2',
            syncReport.ok
              ? 'bg-emerald-500/10 border-emerald-500/20 text-fg'
              : 'bg-amber-500/10 border-amber-500/20 text-fg'
          )}>
            <div className="flex items-center justify-between">
              <span className="font-bold flex items-center gap-1.5">
                {syncReport.ok ? <CheckCircle2 size={16} className="text-emerald-400" /> : <AlertCircle size={16} className="text-amber-400" />}
                {syncReport.message}
              </span>
              <button onClick={() => setSyncReport(null)} className="text-fg-subtle hover:text-fg font-bold">✕</button>
            </div>
            {syncReport.details && syncReport.details.length > 0 && (
              <ul className="space-y-1 text-[11px] text-fg-subtle pt-1 border-t border-line-subtle/50 font-mono">
                {syncReport.details.map((d: string, idx: number) => (
                  <li key={idx}>• {d}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateCompanyForm
          onCreated={() => { setShowCreate(false); loadCompanies() }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton h-32 rounded-2xl" />)}
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
                <div className="card p-5 rounded-2xl border border-line-subtle hover:border-brand-solid/40 transition-colors">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <h2 className="text-h2 text-fg font-bold">{company.name}</h2>
                        <span className="num text-micro text-fg-subtle font-mono">/{company.slug}</span>
                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-surface-inset border border-line-subtle text-brand-ink">
                          {company.plan}
                        </span>
                      </div>

                      <ul className="mt-3 space-y-1">
                        {WEBHOOKS.map(({ key, label, color }) => {
                          const path = `/api/webhooks/${key}/${company.slug}`
                          const copyKey = `wh-${company.id}-${key}`
                          return (
                            <li key={key} className="flex items-center gap-2">
                              <span className="dot" style={{ color }} />
                              <span className="w-16 shrink-0 text-micro text-fg-subtle">{label}</span>
                              <span className="num min-w-0 flex-1 truncate text-micro text-fg-muted font-mono" title={path}>
                                {path}
                              </span>
                              <button
                                onClick={() => copyText(copyKey, `${window.location.origin}${path}`)}
                                aria-label={`Copiar URL do webhook ${label}`}
                                className="focus-ring inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-surface-inset hover:text-fg cursor-pointer"
                              >
                                {copied === copyKey
                                  ? <Check size={13} className="text-st-positivo" />
                                  : <Copy size={13} />}
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 pt-1">
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
                        className={ICON_ACTION}
                      >
                        <Trash2 size={15} />
                      </button>
                      <button
                        onClick={() => handleEnter(company.id)}
                        disabled={entering === company.id}
                        className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-xl bg-brand-solid px-3.5 text-micro font-bold text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50 cursor-pointer shadow-xs ml-1"
                      >
                        <LogIn size={13} />
                        {entering === company.id ? 'Entrando...' : 'Acessar Workspace'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CreateCompanyForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [plan, setPlan] = useState('pro')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  function handleNameChange(val: string) {
    setName(val)
    setSlug(
      val
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const res = await fetch('/api/admin/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, slug, plan }),
    })
    const data = await res.json()
    setLoading(false)
    if (!res.ok) {
      setError(data.error || 'Erro ao criar empresa')
      return
    }
    onCreated()
  }

  return (
    <form onSubmit={handleSubmit} className="card p-5 space-y-4 rise rise-1 rounded-2xl border border-line-subtle">
      <h2 className="text-h2 text-fg font-bold">Nova Empresa</h2>
      {error && <p className="text-micro text-st-negativo">{error}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={FIELD_LABEL}>Nome da empresa</label>
          <input
            className={FIELD}
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="Ex: Minha Empresa"
            required
          />
        </div>
        <div>
          <label className={FIELD_LABEL}>Slug (URL do webhook)</label>
          <input
            className={FIELD}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="Ex: minha-empresa"
            required
          />
        </div>
      </div>
      <div>
        <label className={FIELD_LABEL}>Plano</label>
        <select className={FIELD} value={plan} onChange={(e) => setPlan(e.target.value)}>
          <option value="free">Free</option>
          <option value="pro">Pro</option>
          <option value="enterprise">Enterprise</option>
        </select>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className={GHOST_BUTTON}>Cancelar</button>
        <button type="submit" disabled={loading} className={PRIMARY_BUTTON}>
          {loading ? 'Criando...' : 'Criar empresa'}
        </button>
      </div>
    </form>
  )
}

function EditCompanyForm({
  company,
  onSaved,
  onCancel,
}: {
  company: Company
  onSaved: () => void
  onCancel: () => void
}) {
  const [name, setName] = useState(company.name)
  const [plan, setPlan] = useState(company.plan)
  const [sidebarConfig, setSidebarConfig] = useState<Record<string, boolean>>(company.sidebarConfig || {})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  function applyPreset(preset: 'simplified' | 'full') {
    if (preset === 'simplified') {
      setSidebarConfig({
        showVisaoGeral: true,
        showConversas: true,
        showPipeline: true,
        showLeads: true,
        showAnalise: false,
        showRecuperador: false,
        showMineracao: false,
        showHotmart: false,
        showKiwify: false,
        showGreenn: false,
        showZouti: false,
        showInstagram: false,
        showWebhooksLog: false,
        showBiblioteca: false,
        showConfiguracoes: true,
      })
    } else {
      setSidebarConfig({
        showVisaoGeral: true,
        showConversas: true,
        showPipeline: true,
        showLeads: true,
        showAnalise: true,
        showRecuperador: true,
        showMineracao: true,
        showHotmart: true,
        showKiwify: true,
        showGreenn: true,
        showZouti: true,
        showInstagram: true,
        showWebhooksLog: true,
        showBiblioteca: true,
        showConfiguracoes: true,
      })
    }
  }

  function toggleMenu(key: string) {
    setSidebarConfig(prev => ({
      ...prev,
      [key]: prev[key] === false ? true : false,
    }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const res = await fetch(`/api/admin/companies/${company.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, plan, sidebarConfig }),
    })
    const data = await res.json()
    setLoading(false)
    if (!res.ok) {
      setError(data.error || 'Erro ao salvar empresa')
      return
    }
    onSaved()
  }

  const menuGroups = [
    {
      title: '💬 Atendimento & Vendas',
      items: [
        { key: 'showVisaoGeral', label: 'Visão Geral' },
        { key: 'showConversas', label: 'Conversas (Inbox)' },
        { key: 'showPipeline', label: 'Pipeline (Funil)' },
        { key: 'showLeads', label: 'Todos os Leads' },
      ],
    },
    {
      title: '🔌 Plataformas & Webhooks',
      items: [
        { key: 'showHotmart', label: 'Hotmart' },
        { key: 'showKiwify', label: 'Kiwify' },
        { key: 'showGreenn', label: 'Greenn' },
        { key: 'showZouti', label: 'Zouti' },
        { key: 'showInstagram', label: 'Instagram Direct' },
      ],
    },
    {
      title: '⚡ Ferramentas & Análise',
      items: [
        { key: 'showMineracao', label: 'Mineração & Outbound' },
        { key: 'showRecuperador', label: 'Recuperador Pro' },
        { key: 'showAnalise', label: 'Analytics de Vendas' },
      ],
    },
    {
      title: '⚙️ Sistema',
      items: [
        { key: 'showWebhooksLog', label: 'Logs de Webhooks' },
        { key: 'showBiblioteca', label: 'Biblioteca de Mídia' },
        { key: 'showConfiguracoes', label: 'Configurações' },
      ],
    },
  ]

  return (
    <form onSubmit={handleSubmit} className="card p-5 space-y-4 rounded-2xl border border-line-subtle">
      <h2 className="text-h2 text-fg font-bold">Editar Empresa & Personalizar Menus</h2>
      {error && <p className="text-micro text-st-negativo">{error}</p>}
      
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={FIELD_LABEL}>Nome</label>
          <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <label className={FIELD_LABEL}>Plano</label>
          <select className={FIELD} value={plan} onChange={(e) => setPlan(e.target.value)}>
            <option value="free">Free</option>
            <option value="pro">Pro</option>
            <option value="enterprise">Enterprise</option>
          </select>
        </div>
      </div>

      {/* Menus da Sidebar */}
      <div className="pt-2 border-t border-line-subtle space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-body font-semibold text-fg">Menus Visíveis na Sidebar</h3>
            <p className="text-micro text-fg-subtle">
              Oculte menus desnecessários para entregar uma visão simplificada e limpa para o cliente.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => applyPreset('simplified')}
              className="px-2.5 py-1 text-micro rounded-lg border border-brand-solid/40 bg-brand-solid/10 text-brand-solid hover:bg-brand-solid/20 font-medium transition-colors cursor-pointer"
            >
              ✨ Perfil Simplificado
            </button>
            <button
              type="button"
              onClick={() => applyPreset('full')}
              className="px-2.5 py-1 text-micro rounded-lg border border-line-default bg-surface-inset text-fg-muted hover:text-fg font-medium transition-colors cursor-pointer"
            >
              🌟 Perfil Completo
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
          {menuGroups.map((group) => (
            <div key={group.title} className="p-3 rounded-xl bg-surface-inset/60 border border-line-subtle space-y-2">
              <span className="text-micro font-bold text-fg-muted uppercase tracking-wider">{group.title}</span>
              <div className="grid grid-cols-2 gap-1.5">
                {group.items.map((item) => {
                  const isChecked = sidebarConfig[item.key] !== false
                  return (
                    <label
                      key={item.key}
                      onClick={() => toggleMenu(item.key)}
                      className={cn(
                        'flex items-center gap-2 p-2 rounded-lg border text-micro font-medium cursor-pointer transition-colors select-none',
                        isChecked
                          ? 'border-brand-solid/30 bg-brand-solid/10 text-fg'
                          : 'border-line-subtle bg-surface-base text-fg-subtle opacity-60'
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {}}
                        className="rounded border-line-default text-brand-solid focus:ring-0 cursor-pointer"
                      />
                      <span className="truncate">{item.label}</span>
                    </label>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2 border-t border-line-subtle">
        <button type="button" onClick={onCancel} className={GHOST_BUTTON}>Cancelar</button>
        <button type="submit" disabled={loading} className={PRIMARY_BUTTON}>
          {loading ? 'Salvando...' : 'Salvar Alterações'}
        </button>
      </div>
    </form>
  )
}
