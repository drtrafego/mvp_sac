'use client'

import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  Plus,
  Copy,
  Check,
  X,
  ShieldCheck,
  Zap,
  RefreshCw,
  ChevronRight,
  Search,
  CheckCircle2,
  Clock,
  AlertCircle,
  TrendingUp,
  DollarSign,
  Users,
  MessageSquare,
  Sparkles,
  Phone,
  Layers,
  Settings,
  BarChart3,
  SlidersHorizontal
} from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MessageCard, formatDelay } from './message-card'
import { MobileRowCard } from '@/components/ui/mobile-row-card'
import PeriodBar from '@/components/shared/PeriodBar'
import { resolvePeriod } from '@/lib/period'
import { cn } from '@/lib/utils'

const CONTROL_H = 'h-[var(--control-lg)] lg:h-[var(--control-md)]'
const FIELD = 'bg-surface-inset border-line-subtle placeholder:text-fg-faint focus-ring'

const MESSAGE_TYPE_OPTIONS: Record<string, string> = {
  text: 'Texto',
  image: 'Imagem',
  video: 'Vídeo',
  document: 'Documento',
  audio: 'Áudio',
  interactive_buttons: 'Botões interativos',
  template: 'Template Meta (contatos frios)',
}

interface ButtonOption {
  id: string
  label: string
}

interface MetaTemplate {
  name: string
  status: string
  language: string
  category: string
  components: unknown[]
}

interface Message {
  id: number
  order: number
  messageType: string | null
  content: string | null
  mediaUrl: string | null
  caption: string | null
  buttonsJson?: unknown
  templateName?: string | null
  templateLanguage?: string | null
  templateVariablesMap?: unknown
  delayMinutes: number | null
  isActive: boolean | null
}

interface Sequence {
  id: number
  eventType: string
  isActive: boolean | null
  name: string
  productFilter?: string | null
  upsellMessage?: string | null
  upsellDelayMinutes?: number | null
}

interface Lead {
  id: number
  name: string | null
  phone: string
  productName: string | null
  productValue: number | null
  status: string | null
  convertedFrom: string | null
  createdAt: string | null
}

interface SequencePageProps {
  eventType: string
  title: string
  description: string
}

const emptyButtons: ButtonOption[] = [
  { id: 'btn1', label: '' },
  { id: 'btn2', label: '' },
]

const emptyForm = {
  messageType: 'text',
  content: '',
  mediaUrl: '',
  caption: '',
  delayMinutes: 0,
  buttons: emptyButtons,
  templateName: '',
  templateLanguage: 'pt_BR',
  templateVariablesMap: {} as Record<string, string>,
}

const statusDots: Record<string, string> = {
  pending: 'bg-st-atencao text-st-atencao',
  in_progress: 'bg-st-info text-st-info',
  completed: 'bg-fg-faint text-fg-faint',
  failed: 'bg-st-negativo text-st-negativo',
  converted: 'bg-st-positivo text-st-positivo',
}

const statusLabels: Record<string, string> = {
  pending: 'Pendente',
  in_progress: 'Em andamento',
  completed: 'Concluído',
  failed: 'Falhou',
  converted: 'Convertido',
}

function StatusTag({ lead }: { lead: Lead }) {
  const isConv = lead.status === 'converted'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-micro font-medium whitespace-nowrap border',
        isConv
          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
          : lead.status === 'in_progress'
          ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20'
          : lead.status === 'failed'
          ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20'
          : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          isConv
            ? 'bg-emerald-500 animate-pulse'
            : lead.status === 'in_progress'
            ? 'bg-blue-500'
            : lead.status === 'failed'
            ? 'bg-rose-500'
            : 'bg-amber-500'
        )}
      />
      {leadStatusLabel(lead)}
    </span>
  )
}

function leadStatusLabel(lead: Lead): string {
  if (lead.status === 'converted' && lead.convertedFrom && lead.convertedFrom !== 'webhook') {
    return `Recuperado (Msg ${lead.convertedFrom.replace('msg_', '')})`
  }
  if (lead.status === 'converted') return 'Convertido / Pago'
  return statusLabels[lead.status ?? 'pending'] ?? lead.status ?? '-'
}

function fmtCents(cents: number | null): string {
  if (!cents || isNaN(cents)) return 'R$ 0,00'
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function SequencePage({ eventType, title, description }: SequencePageProps) {
  const [activeTab, setActiveTab] = useState<'leads' | 'settings'>('leads')
  const [sequence, setSequence] = useState<Sequence | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingMessage, setEditingMessage] = useState<Message | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const [flashUrl, setFlashUrl] = useState<string | null>(null)
  const [productFilter, setProductFilter] = useState<string>('')
  const [savingFilter, setSavingFilter] = useState(false)
  const [upsellMessage, setUpsellMessage] = useState<string>('')
  const [upsellDelayMinutes, setUpsellDelayMinutes] = useState<number>(1440)
  const [savingUpsell, setSavingUpsell] = useState(false)
  const [metaTemplates, setMetaTemplates] = useState<MetaTemplate[]>([])
  
  // Filtering & Search
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [selectedProduct, setSelectedProduct] = useState('')
  const [availableProducts, setAvailableProducts] = useState<string[]>([])
  const [leadsLoading, setLeadsLoading] = useState(false)

  const searchParams = useSearchParams()
  const { from, to } = resolvePeriod({
    from: searchParams.get('from') ?? undefined,
    to: searchParams.get('to') ?? undefined,
  })

  const isRecovery = ['boleto', 'pix', 'carrinho_abandonado', 'cartao_recusado'].includes(eventType)

  const [companySlug, setCompanySlug] = useState<string | null>(null)
  const [whatsappProvider, setWhatsappProvider] = useState<string>('meta')

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const hotmartWebhookUrl = companySlug ? `${origin}/api/webhooks/hotmart/${companySlug}` : null
  const greennWebhookUrl = companySlug ? `${origin}/api/webhooks/greenn/${companySlug}` : null
  const zoutiWebhookUrl = companySlug ? `${origin}/api/webhooks/zouti/${companySlug}` : null
  const kiwifyWebhookUrl = companySlug ? `${origin}/api/webhooks/kiwify/${companySlug}` : null
  const metaWebhookUrl = `${origin}/api/webhooks/whatsapp`

  const fetchLeads = useCallback((fromDateStr: string, toDateStr: string, product?: string) => {
    setLeadsLoading(true)
    let url = `/api/leads?event_type=${eventType}&limit=200&from=${fromDateStr}&to=${toDateStr}`
    if (product) url += `&product=${encodeURIComponent(product)}`
    fetch(url)
      .then(r => r.json())
      .then(data => setLeads(Array.isArray(data) ? data : []))
      .catch(() => setLeads([]))
      .finally(() => setLeadsLoading(false))
  }, [eventType])

  useEffect(() => {
    Promise.all([
      fetch(`/api/sequences/${eventType}`).then((r) => r.json()),
      fetch('/api/settings').then((r) => r.json()),
      fetch(`/api/leads?event_type=${eventType}&products_only=true`).then((r) => r.json()),
    ]).then(([seqData, settingsData, products]) => {
      setAvailableProducts(Array.isArray(products) ? products : [])
      setSequence(seqData.sequence)
      setMessages(seqData.messages ?? [])
      setProductFilter(seqData.sequence?.productFilter ?? '')
      setUpsellMessage(seqData.sequence?.upsellMessage ?? '')
      setUpsellDelayMinutes(seqData.sequence?.upsellDelayMinutes ?? 1440)
      setCompanySlug(settingsData.companySlug ?? null)
      setWhatsappProvider(settingsData.whatsappProvider ?? 'meta')
      if (settingsData.whatsappProvider === 'meta' && settingsData.metaWabaId) {
        fetch('/api/meta/templates')
          .then(r => r.ok ? r.json() : [])
          .then(templates => setMetaTemplates(Array.isArray(templates) ? templates : []))
          .catch(() => {})
      }
    }).finally(() => setLoading(false))
  }, [eventType])

  useEffect(() => {
    fetchLeads(from, to, selectedProduct)
  }, [fetchLeads, from, to, selectedProduct])

  async function handleToggle(active: boolean) {
    const res = await fetch(`/api/sequences/${eventType}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: active, name: sequence?.name ?? title }),
    })
    const updated = await res.json()
    setSequence(updated)
  }

  async function handleSaveProductFilter() {
    setSavingFilter(true)
    const res = await fetch(`/api/sequences/${eventType}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: sequence?.name ?? title, productFilter: productFilter || null }),
    })
    const updated = await res.json()
    setSequence(updated)
    setSavingFilter(false)
  }

  async function handleSaveUpsell() {
    setSavingUpsell(true)
    const res = await fetch(`/api/sequences/${eventType}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: sequence?.name ?? title,
        upsellMessage: upsellMessage || null,
        upsellDelayMinutes,
      }),
    })
    const updated = await res.json()
    setSequence(updated)
    setSavingUpsell(false)
  }

  async function handleSaveMessage() {
    setSaving(true)
    try {
      const isButtons = form.messageType === 'interactive_buttons'
      const isText = form.messageType === 'text'
      const isTemplate = form.messageType === 'template'
      const isMedia = !isText && !isButtons && !isTemplate

      const payload = {
        messageType: form.messageType,
        content: (isText || isButtons) ? form.content : null,
        mediaUrl: isMedia ? form.mediaUrl : null,
        caption: isMedia ? form.caption : null,
        buttonsJson: isButtons ? form.buttons.filter(b => b.label.trim()) : null,
        templateName: isTemplate ? form.templateName : null,
        templateLanguage: isTemplate ? form.templateLanguage : null,
        templateVariablesMap: isTemplate ? form.templateVariablesMap : null,
        delayMinutes: form.delayMinutes,
        isActive: true,
      }

      if (editingMessage) {
        const res = await fetch(`/api/sequences/${eventType}/messages/${editingMessage.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const updated = await res.json()
        setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)))
      } else {
        const res = await fetch(`/api/sequences/${eventType}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const created = await res.json()
        setMessages((prev) => [...prev, created])
      }

      setDialogOpen(false)
      setEditingMessage(null)
      setForm(emptyForm)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: number) {
    await fetch(`/api/sequences/${eventType}/messages/${id}`, { method: 'DELETE' })
    setMessages((prev) => prev.filter((m) => m.id !== id))
  }

  async function handleToggleMessage(id: number, active: boolean) {
    const res = await fetch(`/api/sequences/${eventType}/messages/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: active }),
    })
    const updated = await res.json()
    setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)))
  }

  function openEdit(msg: Message) {
    setEditingMessage(msg)
    const existingButtons = Array.isArray(msg.buttonsJson) ? (msg.buttonsJson as ButtonOption[]) : emptyButtons
    const existingVarsMap = (msg.templateVariablesMap && typeof msg.templateVariablesMap === 'object' && !Array.isArray(msg.templateVariablesMap))
      ? msg.templateVariablesMap as Record<string, string>
      : {}
    setForm({
      messageType: msg.messageType ?? 'text',
      content: msg.content ?? '',
      mediaUrl: msg.mediaUrl ?? '',
      caption: msg.caption ?? '',
      delayMinutes: msg.delayMinutes ?? 0,
      buttons: existingButtons.length > 0 ? existingButtons : emptyButtons,
      templateName: msg.templateName ?? '',
      templateLanguage: msg.templateLanguage ?? 'pt_BR',
      templateVariablesMap: existingVarsMap,
    })
    setDialogOpen(true)
  }

  function openNew() {
    setEditingMessage(null)
    setForm(emptyForm)
    setDialogOpen(true)
  }

  async function copyWebhook(url: string) {
    await navigator.clipboard.writeText(url)
    setCopiedUrl(url)
    setFlashUrl(url)
    setTimeout(() => setFlashUrl(null), 400)
    setTimeout(() => setCopiedUrl(null), 2000)
  }

  function setButton(index: number, label: string) {
    setForm(f => {
      const updated = [...f.buttons]
      updated[index] = { ...updated[index], label }
      return { ...f, buttons: updated }
    })
  }

  function addButton() {
    if (form.buttons.length >= 3) return
    setForm(f => ({
      ...f,
      buttons: [...f.buttons, { id: `btn${f.buttons.length + 1}`, label: '' }],
    }))
  }

  function removeButton(index: number) {
    setForm(f => ({
      ...f,
      buttons: f.buttons.filter((_, i) => i !== index),
    }))
  }

  // Filtered Leads
  const filteredLeads = useMemo(() => {
    return leads.filter((lead) => {
      if (statusFilter !== 'all' && lead.status !== statusFilter) return false
      if (!searchQuery.trim()) return true
      const q = searchQuery.toLowerCase().trim()
      const nameMatch = lead.name?.toLowerCase().includes(q) ?? false
      const phoneMatch = lead.phone?.includes(q) ?? false
      const productMatch = lead.productName?.toLowerCase().includes(q) ?? false
      return nameMatch || phoneMatch || productMatch
    })
  }, [leads, statusFilter, searchQuery])

  // Computed Metrics
  const totalLeads = leads.length
  const convertedLeads = leads.filter((l) => l.status === 'converted')
  const convertedCount = convertedLeads.length
  const pendingCount = leads.filter((l) => l.status === 'pending' || l.status === 'in_progress').length
  const conversionRate = totalLeads > 0 ? ((convertedCount / totalLeads) * 100).toFixed(1) : '0.0'
  const recoveredTotalCents = convertedLeads.reduce((acc, l) => acc + (l.productValue ?? 0), 0)
  const pendingTotalCents = leads.filter(l => l.status !== 'converted').reduce((acc, l) => acc + (l.productValue ?? 0), 0)

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="skeleton h-7 w-56" />
            <div className="skeleton h-4 w-72" />
          </div>
          <div className="skeleton h-9 w-28" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map(i => <div key={i} className="skeleton h-24 w-full rounded-[var(--r-lg)]" />)}
        </div>
        <div className="skeleton h-12 w-full" />
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-16 w-full" />
          ))}
        </div>
      </div>
    )
  }

  const activeMessages = messages.filter((m) => m.isActive ?? true).length

  const flowSteps = isRecovery
    ? ['1. Evento recebido via Webhook', '2. Aguarda delay da mensagem', '3. Verifica se já pagou', '4. Se pendente, envia WhatsApp']
    : ['1. Compra confirmada', '2. Envia mensagens de onboarding', '3. Dispara oferta de Upsell após delay programado']

  const flowNote = isRecovery
    ? 'O delay é contado a partir do momento em que o webhook chegou. Cada mensagem tem seu próprio delay independente.'
    : 'A sequência de onboarding respeita o delay de cada mensagem. O upsell é disparado após o tempo configurado.'

  const webhookRows = [
    { label: 'Hotmart', url: hotmartWebhookUrl, dot: 'bg-plat-hotmart' },
    { label: 'Greenn', url: greennWebhookUrl, dot: 'bg-plat-greenn' },
    { label: 'Zouti', url: zoutiWebhookUrl, dot: 'bg-plat-zouti' },
    { label: 'Kiwify', url: kiwifyWebhookUrl, dot: 'bg-plat-kiwify' },
    ...(whatsappProvider === 'meta'
      ? [{ label: 'WhatsApp Meta', url: metaWebhookUrl, dot: 'bg-st-info' }]
      : []),
  ].filter((row): row is { label: string; url: string; dot: string } => Boolean(row.url))

  return (
    <div className="space-y-6">
      {/* ─── CABEÇALHO COM TÍTULO E ABAS DE NAVEGAÇÃO ─── */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between border-b border-line-subtle pb-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-h1 text-fg">{title}</h1>
            <span
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-micro font-medium border',
                sequence?.isActive
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
                  : 'bg-surface-inset text-fg-faint border-line-subtle'
              )}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', sequence?.isActive ? 'bg-emerald-500 animate-pulse' : 'bg-fg-faint')} />
              {sequence?.isActive ? 'Sequência Ativa' : 'Sequência Inativa'}
            </span>
          </div>
          <p className="mt-1 text-body text-fg-muted">{description}</p>
        </div>

        {/* Botões de Alternância de Abas (Vendas vs Configuração) */}
        <div className="flex items-center gap-2 bg-surface-inset p-1 rounded-[var(--r-lg)] border border-line-subtle shrink-0">
          <button
            onClick={() => setActiveTab('leads')}
            className={cn(
              'flex items-center gap-2 px-3.5 py-1.5 rounded-[var(--r-md)] text-body font-medium transition-all cursor-pointer',
              activeTab === 'leads'
                ? 'bg-surface-panel text-fg shadow-sm border border-line-subtle'
                : 'text-fg-muted hover:text-fg'
            )}
          >
            <BarChart3 size={15} className={activeTab === 'leads' ? 'text-brand-ink' : ''} />
            <span>Vendas & Leads</span>
            <span className={cn(
              'num text-micro px-1.5 py-0.2 rounded-full',
              activeTab === 'leads' ? 'bg-brand-ink/10 text-brand-ink font-semibold' : 'bg-surface-raised text-fg-subtle'
            )}>
              {leads.length}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('settings')}
            className={cn(
              'flex items-center gap-2 px-3.5 py-1.5 rounded-[var(--r-md)] text-body font-medium transition-all cursor-pointer',
              activeTab === 'settings'
                ? 'bg-surface-panel text-fg shadow-sm border border-line-subtle'
                : 'text-fg-muted hover:text-fg'
            )}
          >
            <SlidersHorizontal size={15} className={activeTab === 'settings' ? 'text-brand-ink' : ''} />
            <span>Configuração & Mensagens</span>
            <span className={cn(
              'num text-micro px-1.5 py-0.2 rounded-full',
              activeTab === 'settings' ? 'bg-brand-ink/10 text-brand-ink font-semibold' : 'bg-surface-raised text-fg-subtle'
            )}>
              {activeMessages}
            </span>
          </button>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          ABA 1: VENDAS & LEADS (FOCO PRINCIPAL DO OPERADOR)
         ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'leads' && (
        <div className="space-y-6">
          {/* KPI CARDS (DADOS EM TEMPO REAL NO TOPO) */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {/* Card 1: Total Leads */}
            <div className="panel p-4 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-label uppercase text-fg-subtle font-semibold">Total de Leads</span>
                <div className="h-7 w-7 rounded-[var(--r-md)] bg-surface-inset flex items-center justify-center text-fg-muted">
                  <Users size={15} />
                </div>
              </div>
              <div className="mt-3">
                <span className="num text-metric text-fg font-bold">{totalLeads}</span>
                <p className="mt-0.5 text-micro text-fg-subtle">
                  {pendingCount} em recuperação ativa
                </p>
              </div>
            </div>

            {/* Card 2: Convertidos / Recuperados */}
            <div className="panel p-4 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-label uppercase text-emerald-600 dark:text-emerald-400 font-semibold">Vendas Recuperadas</span>
                <div className="h-7 w-7 rounded-[var(--r-md)] bg-emerald-500/10 flex items-center justify-center text-emerald-500">
                  <CheckCircle2 size={15} />
                </div>
              </div>
              <div className="mt-3">
                <span className="num text-metric text-emerald-600 dark:text-emerald-400 font-bold">{convertedCount}</span>
                <p className="mt-0.5 text-micro text-fg-subtle">
                  pedidos confirmados
                </p>
              </div>
            </div>

            {/* Card 3: Taxa de Recuperação */}
            <div className="panel p-4 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-label uppercase text-fg-subtle font-semibold">Taxa de Conversão</span>
                <div className="h-7 w-7 rounded-[var(--r-md)] bg-brand-ink/10 flex items-center justify-center text-brand-ink">
                  <TrendingUp size={15} />
                </div>
              </div>
              <div className="mt-3">
                <span className="num text-metric text-fg font-bold">{conversionRate}%</span>
                <div className="mt-1.5 h-1.5 w-full bg-surface-inset rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(parseFloat(conversionRate) || 0, 100)}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Card 4: Valor Recuperado */}
            <div className="panel p-4 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-label uppercase text-fg-subtle font-semibold">Valor Recuperado</span>
                <div className="h-7 w-7 rounded-[var(--r-md)] bg-emerald-500/10 flex items-center justify-center text-emerald-500">
                  <DollarSign size={15} />
                </div>
              </div>
              <div className="mt-3">
                <span className="num text-metric-sm text-emerald-600 dark:text-emerald-400 font-bold">
                  {fmtCents(recoveredTotalCents)}
                </span>
                <p className="mt-0.5 text-micro text-fg-subtle truncate" title={`Oportunidade Pendente: ${fmtCents(pendingTotalCents)}`}>
                  Pendente: {fmtCents(pendingTotalCents)}
                </p>
              </div>
            </div>
          </div>

          {/* BARRA DE CONTROLE E FILTROS */}
          <div className="panel p-3 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel space-y-3">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
              {/* Esquerda: Seletor de Período Oficial + Filtro por Produto */}
              <div className="flex flex-col sm:flex-row sm:items-center gap-2.5">
                <PeriodBar from={from} to={to} />

                {availableProducts.length > 0 && (
                  <Select
                    value={selectedProduct || '__all__'}
                    onValueChange={v => setSelectedProduct(!v || v === '__all__' ? '' : v)}
                    items={{ __all__: 'Todos os produtos', ...Object.fromEntries(availableProducts.map(p => [p, p])) }}
                  >
                    <SelectTrigger className={cn(FIELD, CONTROL_H, 'w-full sm:w-56 text-body')}>
                      <SelectValue placeholder="Todos os produtos" />
                    </SelectTrigger>
                    <SelectContent className="border border-line-subtle bg-surface-overlay text-fg max-h-64">
                      <SelectItem value="__all__">Todos os produtos</SelectItem>
                      {availableProducts.map(p => (
                        <SelectItem key={p} value={p}>{p}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {/* Direita: Campo de Busca Instantâneo + Atualizar */}
              <div className="flex items-center gap-2">
                <div className="relative flex-1 sm:w-64">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint" />
                  <Input
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Buscar nome, fone, produto..."
                    className={cn(FIELD, CONTROL_H, 'pl-9 text-body w-full')}
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>

                <button
                  onClick={() => fetchLeads(from, to, selectedProduct)}
                  disabled={leadsLoading}
                  className="focus-ring flex h-[var(--control-lg)] w-[var(--control-lg)] lg:h-[var(--control-md)] lg:w-[var(--control-md)] cursor-pointer items-center justify-center rounded-[var(--r-md)] border border-line-subtle bg-surface-inset text-fg-subtle transition-colors hover:bg-surface-raised hover:text-fg disabled:opacity-40 shrink-0"
                  title="Recarregar leads"
                >
                  <RefreshCw size={14} className={leadsLoading ? 'animate-spin' : ''} />
                </button>
              </div>
            </div>

            {/* Quick Status Filter Pills */}
            <div className="flex items-center gap-1.5 overflow-x-auto pt-1 pb-0.5 text-micro scroll-thin">
              <span className="text-fg-subtle text-label uppercase mr-1">Status:</span>
              {[
                { id: 'all', label: `Todos (${leads.length})` },
                { id: 'converted', label: `Convertidos (${convertedCount})` },
                { id: 'pending', label: `Pendentes (${leads.filter(l => l.status === 'pending').length})` },
                { id: 'in_progress', label: `Em andamento (${leads.filter(l => l.status === 'in_progress').length})` },
                { id: 'failed', label: `Falhou (${leads.filter(l => l.status === 'failed').length})` },
              ].map(st => (
                <button
                  key={st.id}
                  onClick={() => setStatusFilter(st.id)}
                  className={cn(
                    'px-2.5 py-1 rounded-full text-micro font-medium transition-colors whitespace-nowrap cursor-pointer',
                    statusFilter === st.id
                      ? 'bg-fg text-surface-base font-semibold shadow-xs'
                      : 'bg-surface-inset text-fg-muted hover:text-fg hover:bg-surface-raised border border-line-subtle'
                  )}
                >
                  {st.label}
                </button>
              ))}
            </div>
          </div>

          {/* LISTA / TABELA DE LEADS */}
          {leadsLoading ? (
            <div className="space-y-2">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="skeleton h-14 w-full rounded-[var(--r-md)]" />
              ))}
            </div>
          ) : filteredLeads.length === 0 ? (
            <div className="rounded-[var(--r-lg)] border border-dashed border-line-default bg-surface-panel p-10 text-center space-y-2">
              <div className="h-10 w-10 mx-auto rounded-full bg-surface-inset flex items-center justify-center text-fg-faint">
                <Users size={20} />
              </div>
              <p className="text-body font-medium text-fg">Nenhum lead encontrado</p>
              <p className="text-micro text-fg-subtle max-w-md mx-auto">
                {searchQuery || statusFilter !== 'all' || selectedProduct
                  ? 'Nenhum lead corresponde aos filtros de busca selecionados. Tente limpar os filtros.'
                  : 'Nenhum evento recebido no período selecionado. Assim que os webhooks forem disparados pela sua plataforma, as oportunidades aparecerão aqui automaticamente.'}
              </p>
            </div>
          ) : (
            <>
              {/* Mobile View: Cards */}
              <div className="md:hidden space-y-2.5">
                {filteredLeads.map((lead) => (
                  <MobileRowCard
                    key={lead.id}
                    title={lead.name ?? 'Cliente sem nome'}
                    subtitle={lead.productName ?? 'Produto sem nome'}
                    meta={
                      <>
                        <span className="num text-fg font-semibold">{fmtCents(lead.productValue)}</span>
                        <span className="num text-fg-muted flex items-center gap-1">
                          <Phone size={11} className="text-fg-faint" />
                          {lead.phone}
                        </span>
                        {lead.phone && (
                          <a
                            href={`https://wa.me/${lead.phone.replace(/\D/g, '')}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Abrir no WhatsApp"
                            className="focus-ring rounded-[var(--r-sm)] text-emerald-500 hover:text-emerald-400 p-0.5"
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                            </svg>
                          </a>
                        )}
                        <span className="num text-fg-subtle">
                          {lead.createdAt ? new Date(lead.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '-'}
                        </span>
                      </>
                    }
                    badges={<StatusTag lead={lead} />}
                  />
                ))}
              </div>

              {/* Desktop View: Tabela Elegante */}
              <div className="panel hidden md:block overflow-hidden rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel">
                <div className="scroll-thin overflow-x-auto">
                  <table className="w-full text-body text-left">
                    <thead>
                      <tr className="border-b border-line-subtle bg-surface-inset/50">
                        <th className="px-4 py-3 text-label uppercase text-fg-subtle whitespace-nowrap">Cliente</th>
                        <th className="px-4 py-3 text-label uppercase text-fg-subtle whitespace-nowrap">WhatsApp</th>
                        <th className="px-4 py-3 text-label uppercase text-fg-subtle whitespace-nowrap">Produto</th>
                        <th className="px-4 py-3 text-label uppercase text-fg-subtle whitespace-nowrap">Valor</th>
                        <th className="px-4 py-3 text-label uppercase text-fg-subtle whitespace-nowrap">Status</th>
                        <th className="px-4 py-3 text-label uppercase text-fg-subtle whitespace-nowrap">Data do Evento</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line-subtle">
                      {filteredLeads.map((lead) => (
                        <tr key={lead.id} className="tr-hover transition-colors">
                          {/* Nome do Cliente */}
                          <td className="px-4 py-3.5">
                            <div className="flex items-center gap-2.5">
                              <div className="h-7 w-7 rounded-full bg-surface-raised border border-line-subtle flex items-center justify-center text-micro font-semibold text-fg-muted shrink-0">
                                {lead.name ? lead.name.slice(0, 2).toUpperCase() : '??'}
                              </div>
                              <span className="font-medium text-fg truncate max-w-[180px]" title={lead.name ?? ''}>
                                {lead.name ?? <span className="text-fg-faint">Sem nome</span>}
                              </span>
                            </div>
                          </td>

                          {/* Telefone & WhatsApp */}
                          <td className="px-4 py-3.5">
                            <div className="flex items-center gap-2">
                              <span className="num text-micro text-fg-muted font-medium">{lead.phone}</span>
                              {lead.phone && (
                                <a
                                  href={`https://wa.me/${lead.phone.replace(/\D/g, '')}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title="Iniciar conversa no WhatsApp"
                                  className="focus-ring p-1 rounded-[var(--r-sm)] text-fg-faint hover:text-emerald-500 hover:bg-emerald-500/10 transition-colors"
                                >
                                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                                  </svg>
                                </a>
                              )}
                            </div>
                          </td>

                          {/* Produto */}
                          <td className="px-4 py-3.5 max-w-[200px]">
                            <span className="block truncate text-micro text-fg-muted font-medium" title={lead.productName ?? undefined}>
                              {lead.productName ?? <span className="text-fg-faint">-</span>}
                            </span>
                          </td>

                          {/* Valor */}
                          <td className="num px-4 py-3.5 whitespace-nowrap text-body font-semibold text-fg">
                            {fmtCents(lead.productValue)}
                          </td>

                          {/* Status */}
                          <td className="px-4 py-3.5 whitespace-nowrap">
                            <StatusTag lead={lead} />
                          </td>

                          {/* Data */}
                          <td className="num px-4 py-3.5 whitespace-nowrap text-micro text-fg-subtle">
                            {lead.createdAt ? new Date(lead.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          ABA 2: CONFIGURAÇÃO & MENSAGENS DA SEQUÊNCIA
         ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'settings' && (
        <div className="space-y-6">
          {/* Master Switch & How It Works */}
          <div className="panel p-5 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="space-y-1">
              <h2 className="text-h2 text-fg">Disparo Automático da Sequência</h2>
              <p className="text-micro text-fg-muted">
                Quando ativada, as mensagens programadas abaixo serão enviadas automaticamente para novos eventos recebidos.
              </p>
            </div>
            <div className="flex items-center gap-3 bg-surface-inset px-4 py-2 rounded-[var(--r-md)] border border-line-subtle shrink-0">
              <span className="text-body font-medium text-fg">{sequence?.isActive ? 'Sequência Ativa' : 'Sequência Pausada'}</span>
              <Switch
                checked={sequence?.isActive ?? false}
                onCheckedChange={handleToggle}
              />
            </div>
          </div>

          {/* Fluxo Explicativo */}
          <div className="rounded-[var(--r-lg)] border border-line-subtle bg-surface-inset p-4">
            <p className="text-label uppercase text-fg-subtle font-semibold">Como funciona o fluxo de disparo</p>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
              {flowSteps.map((step, i) => (
                <Fragment key={step}>
                  {i > 0 && <ChevronRight size={13} className="text-fg-faint" />}
                  <span className="text-micro font-medium text-fg-muted">{step}</span>
                </Fragment>
              ))}
            </div>
            <p className="mt-2.5 text-micro text-fg-subtle">{flowNote}</p>
          </div>

          {/* Filtro por Produto */}
          <div className="panel space-y-2.5 p-5 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel">
            <div className="flex items-center justify-between">
              <h3 className="text-h3 text-fg font-semibold">Filtro de Disparo por Produto (Opcional)</h3>
              <span className="text-micro text-fg-subtle">Deixe em branco para disparar para todos</span>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={productFilter}
                onChange={e => setProductFilter(e.target.value)}
                placeholder="ID ou nome do produto (ex: Curso de Tráfego Pago)"
                className={cn(FIELD, CONTROL_H, 'flex-1 text-body')}
              />
              <Button onClick={handleSaveProductFilter} disabled={savingFilter} className={cn(CONTROL_H, 'focus-ring px-5')}>
                {savingFilter ? 'Salvando...' : 'Salvar Filtro'}
              </Button>
            </div>
            <p className="text-micro text-fg-subtle">Se preenchido, esta sequência só dispara para webhooks deste produto específico.</p>
          </div>

          {/* Mensagens da Sequência */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-h2 text-fg">Mensagens da Sequência</h2>
                <p className="text-micro text-fg-subtle">Configure os passos e intervalos de disparo de cada mensagem</p>
              </div>
              <Button onClick={openNew} className={cn(CONTROL_H, 'focus-ring flex items-center gap-2 px-4')}>
                <Plus size={15} />
                Adicionar mensagem
              </Button>
            </div>

            {messages.length === 0 && (
              <div className="rounded-[var(--r-lg)] border border-dashed border-line-default bg-surface-panel p-10 text-center text-body text-fg-subtle">
                Nenhuma mensagem configurada. Adicione a primeira mensagem da sequência.
              </div>
            )}

            {messages.length > 0 && (
              <div>
                {messages.map((msg) => (
                  <MessageCard
                    key={msg.id}
                    message={msg}
                    onEdit={openEdit}
                    onDelete={handleDelete}
                    onToggle={handleToggleMessage}
                  />
                ))}
              </div>
            )}
          </div>

          {/* URLs de Webhooks */}
          <div className="panel p-5 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel space-y-3">
            <div>
              <h3 className="text-h3 text-fg font-semibold">URLs de Webhook para Integração</h3>
              <p className="text-micro text-fg-subtle">Copie e cole estas URLs nas configurações de webhook das suas plataformas de pagamento.</p>
            </div>

            {!companySlug && (
              <p className="text-micro text-st-atencao">Configure o slug da empresa em Ajustes para gerar as URLs personalizadas.</p>
            )}

            {webhookRows.length > 0 && (
              <div className="space-y-1.5 pt-1">
                {webhookRows.map((row) => (
                  <div
                    key={row.label}
                    className={cn(
                      'flex items-center gap-3 rounded-[var(--r-md)] border border-line-subtle bg-surface-inset px-3 py-2 transition-colors duration-200',
                      flashUrl === row.url && 'bg-[var(--brand-glow)]'
                    )}
                  >
                    <span className={cn('h-2 w-2 rounded-full shrink-0', row.dot)} />
                    <span className="w-24 shrink-0 font-medium text-micro text-fg">{row.label}</span>
                    <code className="num text-micro min-w-0 flex-1 truncate text-fg-subtle select-all font-mono">{row.url}</code>
                    <button
                      onClick={() => copyWebhook(row.url)}
                      title={`Copiar URL da ${row.label}`}
                      className="focus-ring flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[var(--r-md)] text-fg-subtle transition-colors hover:bg-surface-raised hover:text-fg"
                    >
                      {copiedUrl === row.url ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Upsell (só para compra_aprovada) */}
          {!isRecovery && (
            <div className="panel space-y-3 p-5 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel">
              <div className="flex items-center gap-2">
                <Zap size={16} className="text-st-atencao" />
                <h2 className="text-h2 text-fg">Oferta de Upsell Pós-Compra</h2>
              </div>
              <p className="text-micro text-fg-subtle">
                Enviada automaticamente após o tempo abaixo para quem comprou. Use para oferecer um produto complementar ou mentoria.
              </p>
              <div className="space-y-1.5">
                <label className="block text-label uppercase text-fg-subtle">Enviar após quantos minutos da compra?</label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={upsellDelayMinutes}
                    onChange={e => setUpsellDelayMinutes(parseInt(e.target.value) || 1440)}
                    className={cn(FIELD, CONTROL_H, 'num w-28 rounded-[var(--r-md)] border px-3 text-body outline-none')}
                  />
                  <span className="text-micro text-fg-subtle">
                    = {formatDelay(upsellDelayMinutes)} após a compra
                  </span>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="block text-label uppercase text-fg-subtle">Mensagem de upsell</label>
                <textarea
                  value={upsellMessage}
                  onChange={e => setUpsellMessage(e.target.value)}
                  placeholder="Ex: Oi {primeiro_nome}! Que ótimo que você adquiriu o {produto}! Tenho uma oferta especial para você..."
                  rows={4}
                  className={cn(FIELD, 'w-full resize-none rounded-[var(--r-md)] border px-3 py-2 text-body outline-none')}
                />
                <p className="text-micro text-fg-subtle">Variáveis disponíveis: {'{primeiro_nome}'}, {'{nome}'}, {'{produto}'}, {'{valor}'}</p>
              </div>
              <Button onClick={handleSaveUpsell} disabled={savingUpsell} className={cn(CONTROL_H, 'focus-ring px-5')}>
                {savingUpsell ? 'Salvando...' : 'Salvar Oferta de Upsell'}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ─── MODAL DE ADICIONAR / EDITAR MENSAGEM ─── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="scroll-thin w-[calc(100%-2rem)] max-w-lg max-h-[85vh] overflow-y-auto rounded-[var(--r-xl)] border border-line-subtle bg-surface-overlay">
          <DialogHeader>
            <DialogTitle className="text-h2">{editingMessage ? 'Editar Mensagem da Sequência' : 'Nova Mensagem da Sequência'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <label className="block text-label uppercase text-fg-subtle">Tipo da Mensagem</label>
              <Select
                value={form.messageType}
                onValueChange={(v) => v && setForm((f) => ({ ...f, messageType: v }))}
                items={MESSAGE_TYPE_OPTIONS}
              >
                <SelectTrigger className={cn(FIELD, CONTROL_H, 'w-full text-body')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border border-line-subtle bg-surface-overlay text-fg">
                  {Object.entries(MESSAGE_TYPE_OPTIONS)
                    .filter(([value]) => value !== 'template' || metaTemplates.length > 0)
                    .map(([value, label]) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            {form.messageType === 'text' && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="block text-label uppercase text-fg-subtle">Conteúdo do Texto</label>
                  <span className="text-micro text-fg-faint">Clique nas variáveis para inserir:</span>
                </div>
                <div className="flex flex-wrap gap-1.5 pb-1">
                  {[
                    { key: '{primeiro_nome}', label: 'Primeiro Nome' },
                    { key: '{nome}', label: 'Nome Completo' },
                    { key: '{produto}', label: 'Nome do Produto' },
                    { key: '{valor}', label: 'Valor R$' },
                    { key: '{link_checkout}', label: 'Link de Checkout' },
                    { key: '{pix_codigo}', label: 'Código Pix Copia e Cola' },
                    { key: '{boleto_url}', label: 'Link do Boleto' },
                  ].map(v => (
                    <button
                      key={v.key}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, content: (f.content || '') + ' ' + v.key }))}
                      className="cursor-pointer rounded-[var(--r-sm)] border border-line-subtle bg-surface-inset px-2 py-0.5 text-micro text-brand-ink transition-colors hover:bg-surface-raised hover:text-fg"
                      title={v.label}
                    >
                      +{v.key}
                    </button>
                  ))}
                </div>
                <Textarea
                  value={form.content}
                  onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                  placeholder="Digite a mensagem que o lead receberá no WhatsApp..."
                  className={cn(FIELD, 'min-h-[120px] text-body')}
                />
                <p className="text-micro text-fg-subtle">
                  Variáveis suportadas: {'{primeiro_nome}'}, {'{nome}'}, {'{produto}'}, {'{valor}'}, {'{pix_codigo}'}, {'{boleto_url}'}, {'{link_checkout}'}.
                </p>
              </div>
            )}

            {form.messageType === 'interactive_buttons' && (
              <>
                <div className="space-y-1.5">
                  <label className="block text-label uppercase text-fg-subtle">Texto da Mensagem</label>
                  <Textarea
                    value={form.content}
                    onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                    placeholder="Texto que aparece acima dos botões..."
                    className={cn(FIELD, 'min-h-[80px] text-body')}
                  />
                </div>
                <div className="space-y-2">
                  <label className="block text-label uppercase text-fg-subtle">Botões de Ação (Máximo 3)</label>
                  {form.buttons.map((btn, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        value={btn.label}
                        onChange={(e) => setButton(i, e.target.value)}
                        placeholder={`Botão ${i + 1} (ex: Pagar Agora)`}
                        maxLength={20}
                        className={cn(FIELD, CONTROL_H, 'text-body')}
                      />
                      {form.buttons.length > 1 && (
                        <button
                          onClick={() => removeButton(i)}
                          title="Remover botão"
                          className="focus-ring flex h-[var(--control-lg)] w-[var(--control-lg)] lg:h-[var(--control-md)] lg:w-[var(--control-md)] shrink-0 cursor-pointer items-center justify-center rounded-[var(--r-md)] text-fg-subtle transition-colors hover:bg-surface-inset hover:text-st-negativo"
                        >
                          <X size={15} />
                        </button>
                      )}
                    </div>
                  ))}
                  {form.buttons.length < 3 && (
                    <button
                      onClick={addButton}
                      className="focus-ring flex cursor-pointer items-center gap-1 rounded-[var(--r-sm)] text-micro text-fg-muted transition-colors hover:text-fg"
                    >
                      <Plus size={12} /> Adicionar outro botão
                    </button>
                  )}
                </div>
              </>
            )}

            {form.messageType === 'template' && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="block text-label uppercase text-fg-subtle">Template Meta</label>
                  <Select
                    value={form.templateName}
                    onValueChange={(v) => {
                      const tpl = metaTemplates.find(t => t.name === v)
                      setForm(f => ({ ...f, templateName: v ?? '', templateLanguage: tpl?.language ?? 'pt_BR' }))
                    }}
                    items={Object.fromEntries(metaTemplates.map(t => [t.name, `${t.name} (${t.language})`]))}
                  >
                    <SelectTrigger className={cn(FIELD, CONTROL_H, 'w-full text-body')}>
                      <SelectValue placeholder="Selecione um template aprovado..." />
                    </SelectTrigger>
                    <SelectContent className="border border-line-subtle bg-surface-overlay text-fg">
                      {metaTemplates.map(t => (
                        <SelectItem key={t.name} value={t.name}>
                          {t.name} ({t.language})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <label className="block text-label uppercase text-fg-subtle">Variáveis do Template</label>
                  {[1, 2, 3, 4, 5].map(i => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="num text-micro w-10 shrink-0 text-fg-muted">{`{{${i}}}`}</span>
                      <Input
                        value={form.templateVariablesMap[String(i)] ?? ''}
                        onChange={e => setForm(f => ({
                          ...f,
                          templateVariablesMap: { ...f.templateVariablesMap, [String(i)]: e.target.value }
                        }))}
                        placeholder="{nome}, {produto}, {valor}..."
                        className={cn(FIELD, CONTROL_H, 'text-body')}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {form.messageType !== 'text' && form.messageType !== 'interactive_buttons' && form.messageType !== 'template' && (
              <>
                <div className="space-y-1.5">
                  <label className="block text-label uppercase text-fg-subtle">URL da Mídia (HTTPS)</label>
                  <Input
                    value={form.mediaUrl}
                    onChange={(e) => setForm((f) => ({ ...f, mediaUrl: e.target.value }))}
                    placeholder="https://sua-empresa.com/imagem.png"
                    className={cn(FIELD, CONTROL_H, 'text-body')}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-label uppercase text-fg-subtle">Legenda da Mídia</label>
                  <Input
                    value={form.caption}
                    onChange={(e) => setForm((f) => ({ ...f, caption: e.target.value }))}
                    placeholder="Legenda opcional..."
                    className={cn(FIELD, CONTROL_H, 'text-body')}
                  />
                </div>
              </>
            )}

            <div className="space-y-1.5">
              <label className="block text-label uppercase text-fg-subtle">
                Delay de Disparo (Minutos após o evento)
                {form.delayMinutes > 0 && (
                  <span className="num text-micro ml-2 font-normal normal-case tracking-normal text-fg-muted">
                    = {formatDelay(form.delayMinutes)}
                  </span>
                )}
              </label>
              <Input
                type="number"
                min={0}
                value={form.delayMinutes}
                onChange={(e) => setForm((f) => ({ ...f, delayMinutes: parseInt(e.target.value) || 0 }))}
                className={cn(FIELD, CONTROL_H, 'num text-body')}
              />
              {isRecovery && (
                <p className="flex items-center gap-1.5 text-micro text-fg-subtle">
                  <ShieldCheck size={12} className="text-emerald-500" />
                  Antes de enviar, o sistema verifica automaticamente se o lead já pagou e cancela o envio caso tenha sido pago.
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-line-subtle">
              <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving} className={cn(CONTROL_H, 'focus-ring px-4')}>
                Cancelar
              </Button>
              <Button onClick={handleSaveMessage} disabled={saving} className={cn(CONTROL_H, 'focus-ring px-5')}>
                {saving ? 'Salvando...' : 'Salvar Mensagem'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
