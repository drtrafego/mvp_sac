'use client'

import { useState, useEffect, useCallback, Fragment } from 'react'
import { Plus, Copy, Check, X, ShieldCheck, Zap, RefreshCw, ChevronRight } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MessageCard, formatDelay } from './message-card'
import { MobileRowCard } from '@/components/ui/mobile-row-card'
import { cn } from '@/lib/utils'

/* Altura única de controle: 44px no toque, 36px a partir do desktop */
const CONTROL_H = 'h-[var(--control-lg)] lg:h-[var(--control-md)]'
/*
  Sem classe de cor de texto aqui: o tailwind-merge trata text-body e text-fg como
  o mesmo grupo e descartaria uma das duas. A cor do campo vem por herança.
*/
const FIELD = 'bg-surface-inset border-line-subtle placeholder:text-fg-faint focus-ring'

/*
  Os selects do Base UI mostram o valor cru no gatilho quando o Root não recebe
  `items`, então o tipo da mensagem aparecia como "text" em vez de "Texto".
*/
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

/* Status vira ponto colorido mais texto neutro, a mesma linguagem do resto do painel */
const statusDots: Record<string, string> = {
  pending: 'text-st-atencao',
  in_progress: 'text-st-info',
  completed: 'text-fg-faint',
  failed: 'text-st-negativo',
  converted: 'text-st-positivo',
}

const statusLabels: Record<string, string> = {
  pending: 'Pendente',
  in_progress: 'Em andamento',
  completed: 'Concluído',
  failed: 'Falhou',
  converted: 'Convertido',
}

function StatusTag({ lead }: { lead: Lead }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-micro text-fg-muted">
      <span className={cn('dot', statusDots[lead.status ?? 'pending'] ?? 'text-fg-faint')} />
      {leadStatusLabel(lead)}
    </span>
  )
}

function leadStatusLabel(lead: Lead): string {
  if (lead.status === 'converted' && lead.convertedFrom && lead.convertedFrom !== 'webhook') {
    return `Recuperado msg ${lead.convertedFrom.replace('msg_', '')}`
  }
  if (lead.status === 'converted') return 'Pagou sozinho'
  return statusLabels[lead.status ?? 'pending'] ?? lead.status ?? '-'
}

function fmtCents(cents: number | null): string {
  if (!cents) return '-'
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function SequencePage({ eventType, title, description }: SequencePageProps) {
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
  const [period, setPeriod] = useState('30d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [leadsLoading, setLeadsLoading] = useState(false)
  const [selectedProduct, setSelectedProduct] = useState('')
  const [availableProducts, setAvailableProducts] = useState<string[]>([])

  const isRecovery = ['boleto', 'pix', 'carrinho_abandonado', 'cartao_recusado'].includes(eventType)

  const [companySlug, setCompanySlug] = useState<string | null>(null)
  const [whatsappProvider, setWhatsappProvider] = useState<string>('meta')

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const hotmartWebhookUrl = companySlug ? `${origin}/api/webhooks/hotmart/${companySlug}` : null
  const greennWebhookUrl = companySlug ? `${origin}/api/webhooks/greenn/${companySlug}` : null
  const zoutiWebhookUrl = companySlug ? `${origin}/api/webhooks/zouti/${companySlug}` : null
  const kiwifyWebhookUrl = companySlug ? `${origin}/api/webhooks/kiwify/${companySlug}` : null
  const metaWebhookUrl = `${origin}/api/webhooks/whatsapp`

  const fetchLeads = useCallback((p: string, from?: string, to?: string, product?: string) => {
    setLeadsLoading(true)
    let url = `/api/leads?event_type=${eventType}&limit=100&period=${p}`
    if (p === 'custom' && from) url += `&from=${from}`
    if (p === 'custom' && to) url += `&to=${to}`
    if (product) url += `&product=${encodeURIComponent(product)}`
    fetch(url)
      .then(r => r.json())
      .then(data => setLeads(Array.isArray(data) ? data : []))
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
    fetchLeads(period, customFrom, customTo, selectedProduct)
  }, [fetchLeads, period, selectedProduct])

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
    // O piscar confirma a linha certa; o check confirma a ação por mais tempo
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
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-28 w-full" />
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-24 w-full" />
          ))}
        </div>
      </div>
    )
  }

  const activeMessages = messages.filter((m) => m.isActive ?? true).length

  const flowSteps = isRecovery
    ? ['Evento recebido', 'Aguarda o delay de cada mensagem', 'Verifica se já pagou', 'Se não pagou, envia a mensagem']
    : ['Compra confirmada', 'Envia a sequência de onboarding', 'Envia a mensagem de upsell após o delay']

  const flowNote = isRecovery
    ? 'O delay é contado a partir do momento em que o evento chegou. Cada mensagem tem o próprio delay configurável.'
    : 'A sequência de onboarding respeita o delay de cada mensagem. O upsell é uma mensagem separada, enviada após o tempo configurado abaixo.'

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
      <div className="rise rise-1 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-h1 text-fg">{title}</h1>
          <p className="mt-1 text-body text-fg-muted">{description}</p>
        </div>
        <div className="shrink-0 text-right">
          <div className="flex items-center justify-end gap-2.5">
            <span className="text-body text-fg">{sequence?.isActive ? 'Ativa' : 'Inativa'}</span>
            <Switch
              checked={sequence?.isActive ?? false}
              onCheckedChange={handleToggle}
            />
          </div>
          <p className="mt-1 text-micro text-fg-subtle">
            <span className="num">{activeMessages}</span>{' '}
            {activeMessages === 1 ? 'mensagem ativa' : 'mensagens ativas'}
          </p>
        </div>
      </div>

      {/* Fluxo do evento, em faixa neutra: a cor fica reservada para dado, não para aviso */}
      <div className="rise rise-2 rounded-[var(--r-lg)] border border-line-subtle bg-surface-inset p-4">
        <p className="text-label uppercase text-fg-subtle">Como funciona</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {flowSteps.map((step, i) => (
            <Fragment key={step}>
              {i > 0 && <ChevronRight size={13} className="text-fg-faint" />}
              <span className="text-micro text-fg-muted">{step}</span>
            </Fragment>
          ))}
        </div>
        <p className="mt-2.5 text-micro text-fg-subtle">{flowNote}</p>
      </div>

      {/* Filtro por produto (Fase 3.1) */}
      <div className="rise rise-3 panel space-y-2.5 p-[var(--space-card)]">
        <p className="text-label uppercase text-fg-subtle">Filtro por produto (opcional)</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={productFilter}
            onChange={e => setProductFilter(e.target.value)}
            placeholder="ID ou nome do produto. Vazio dispara para todos."
            className={cn(FIELD, CONTROL_H, 'flex-1 text-body')}
          />
          <Button onClick={handleSaveProductFilter} disabled={savingFilter} className={cn(CONTROL_H, 'focus-ring px-4')}>
            {savingFilter ? 'Salvando...' : 'Salvar'}
          </Button>
        </div>
        <p className="text-micro text-fg-subtle">Se preenchido, esta sequência só dispara para webhooks deste produto específico.</p>
      </div>

      <div className="rise rise-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-h2 text-fg">Mensagens da sequência</h2>
          <Button onClick={openNew} className={cn(CONTROL_H, 'focus-ring flex items-center gap-2 px-4')}>
            <Plus size={15} />
            Adicionar mensagem
          </Button>
        </div>

        {messages.length === 0 && (
          <div className="rounded-[var(--r-lg)] border border-dashed border-line-default p-10 text-center text-body text-fg-subtle">
            Nenhuma mensagem configurada. Adicione a primeira mensagem da sequência.
          </div>
        )}

        {/* Timeline: os cards se encaixam sem gap para o filete não quebrar */}
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

        <div className="mt-4 rounded-[var(--r-lg)] border border-line-subtle bg-surface-inset p-[var(--space-card)]">
          <p className="text-label uppercase text-fg-subtle">URLs de webhook</p>
          {!companySlug && (
            <p className="mt-2.5 text-micro text-fg-faint">Configure as credenciais em Configurações para ver a URL de cada plataforma.</p>
          )}
          {webhookRows.length > 0 && (
            <div className="mt-2 space-y-0.5">
              {webhookRows.map((row) => (
                <div
                  key={row.label}
                  className={cn(
                    'flex items-center gap-2.5 rounded-[var(--r-md)] px-2 py-1 transition-colors duration-200',
                    flashUrl === row.url && 'bg-[var(--brand-glow)]'
                  )}
                >
                  <span className={cn('dot', row.dot)} />
                  <span className="w-24 shrink-0 truncate text-micro text-fg-muted">{row.label}</span>
                  <code className="num text-micro min-w-0 flex-1 truncate text-fg-subtle">{row.url}</code>
                  <button
                    onClick={() => copyWebhook(row.url)}
                    title={`Copiar URL da ${row.label}`}
                    className="focus-ring flex h-[var(--control-lg)] w-[var(--control-lg)] shrink-0 cursor-pointer items-center justify-center rounded-[var(--r-md)] text-fg-subtle transition-colors hover:bg-surface-raised hover:text-fg lg:h-8 lg:w-8"
                  >
                    {copiedUrl === row.url ? <Check size={14} className="text-brand-ink" /> : <Copy size={14} />}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Upsell, só para compra_aprovada */}
      {!isRecovery && (
        <div className="rise rise-5 panel space-y-3 p-[var(--space-card)]">
          <div className="flex items-center gap-2">
            <Zap size={15} className="text-st-atencao" />
            <h2 className="text-h2 text-fg">Mensagem de upsell</h2>
          </div>
          <p className="text-micro text-fg-subtle">
            Enviada automaticamente após o tempo abaixo, para quem comprou. Use para oferecer um produto complementar, acesso VIP, entre outros.
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
          <Button onClick={handleSaveUpsell} disabled={savingUpsell} className={cn(CONTROL_H, 'focus-ring px-4')}>
            {savingUpsell ? 'Salvando...' : 'Salvar upsell'}
          </Button>
        </div>
      )}

      <div className="rise rise-6 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <h2 className="flex items-center gap-2 text-h2 text-fg">
              Leads recentes
              {leadsLoading
                ? <span className="skeleton inline-block h-3.5 w-20" />
                : <span className="num text-micro font-normal text-fg-subtle">{leads.length} registros</span>}
            </h2>
            <button
              onClick={() => fetchLeads(period, customFrom, customTo, selectedProduct)}
              disabled={leadsLoading}
              className="focus-ring flex h-[var(--control-lg)] w-[var(--control-lg)] lg:h-[var(--control-md)] lg:w-[var(--control-md)] cursor-pointer items-center justify-center rounded-[var(--r-md)] text-fg-subtle transition-colors hover:bg-surface-inset hover:text-fg disabled:opacity-40"
              title="Atualizar"
            >
              <RefreshCw size={14} className={leadsLoading ? 'animate-spin' : ''} />
            </button>
          </div>
          <div className="w-full md:w-auto flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:gap-1.5">
            {availableProducts.length > 0 && (
              <Select
                value={selectedProduct || '__all__'}
                onValueChange={v => setSelectedProduct(!v || v === '__all__' ? '' : v)}
                items={{ __all__: 'Todos os produtos', ...Object.fromEntries(availableProducts.map(p => [p, p])) }}
              >
                <SelectTrigger className={cn(FIELD, CONTROL_H, 'w-full text-micro md:w-48')}>
                  <SelectValue placeholder="Todos os produtos" />
                </SelectTrigger>
                <SelectContent className="border border-line-subtle bg-surface-overlay text-fg">
                  <SelectItem value="__all__">Todos os produtos</SelectItem>
                  {availableProducts.map(p => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {/* Chips de período: rolagem horizontal no celular */}
            <div
              className="flex gap-1.5 overflow-x-auto -mx-4 px-4 lg:mx-0 lg:px-0 lg:flex-wrap lg:items-center"
              style={{ scrollbarWidth: 'none' }}
            >
              {[
                { value: 'today', label: 'Hoje' },
                { value: 'yesterday', label: 'Ontem' },
                { value: '7d', label: '7 dias' },
                { value: '14d', label: '14 dias' },
                { value: '30d', label: '30 dias' },
                { value: 'month', label: 'Este mês' },
                { value: 'all', label: 'Tudo' },
                { value: 'custom', label: 'Personalizado' },
              ].map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setPeriod(value)}
                  className={`focus-ring shrink-0 inline-flex items-center rounded-[var(--r-md)] border px-3.5 text-micro font-medium transition-colors cursor-pointer h-[var(--control-lg)] lg:h-[var(--control-sm)] lg:px-2.5 ${
                    period === value
                      ? 'bg-surface-overlay border-line-strong text-fg'
                      : 'border-line-subtle bg-surface-inset text-fg-subtle hover:text-fg'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {period === 'custom' && (
          <div className="flex flex-wrap gap-3 items-center">
            <div className="flex items-center gap-2">
              <label className="block text-label uppercase text-fg-subtle">De</label>
              <input
                type="date"
                value={customFrom}
                onChange={e => {
                  setCustomFrom(e.target.value)
                  if (e.target.value) fetchLeads('custom', e.target.value, customTo)
                }}
                className={cn(FIELD, CONTROL_H, 'native-field num rounded-[var(--r-md)] border px-2.5 text-body outline-none')}
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="block text-label uppercase text-fg-subtle">Até</label>
              <input
                type="date"
                value={customTo}
                onChange={e => {
                  setCustomTo(e.target.value)
                  if (customFrom) fetchLeads('custom', customFrom, e.target.value)
                }}
                className={cn(FIELD, CONTROL_H, 'native-field num rounded-[var(--r-md)] border px-2.5 text-body outline-none')}
              />
            </div>
          </div>
        )}

        {leadsLoading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="skeleton h-12 w-full" />
            ))}
          </div>
        ) : leads.length === 0 ? (
          <div className="rounded-[var(--r-lg)] border border-line-subtle bg-surface-inset p-6 text-center text-body text-fg-subtle">
            Nenhum lead ainda para este tipo de recuperação.
          </div>
        ) : (
          <>
          {/* Mobile: cada lead vira um card */}
          <div className="md:hidden space-y-2">
            {leads.map((lead) => (
              <MobileRowCard
                key={lead.id}
                title={lead.name ?? '-'}
                subtitle={lead.productName ?? '-'}
                meta={
                  <>
                    <span className="num text-fg font-medium">{fmtCents(lead.productValue)}</span>
                    <span className="num text-fg-muted">{lead.phone}</span>
                    {lead.phone && (
                      <a
                        href={`https://wa.me/${lead.phone.replace(/\D/g, '')}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Abrir no WhatsApp"
                        className="focus-ring rounded-[var(--r-sm)] text-fg-faint transition-colors hover:text-brand-ink"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
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

          {/* Desktop: tabela com rolagem horizontal própria */}
          <div className="card-section hidden md:block overflow-hidden">
            <div className="scroll-thin overflow-x-auto">
            <table className="w-full text-body">
              <thead>
                <tr className="border-b border-line-subtle">
                  {['Nome', 'Telefone', 'Produto', 'Valor', 'Status', 'Data'].map((col) => (
                    <th key={col} className="px-4 py-3 text-left text-label uppercase text-fg-subtle whitespace-nowrap">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr key={lead.id} className="tr-hover border-b border-line-subtle">
                    <td className="px-4 py-3 text-fg">{lead.name ?? '-'}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="num text-micro text-fg-muted">{lead.phone}</span>
                        {lead.phone && (
                          <a
                            href={`https://wa.me/${lead.phone.replace(/\D/g, '')}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Abrir no WhatsApp"
                            className="focus-ring shrink-0 rounded-[var(--r-sm)] text-fg-faint transition-colors duration-150 hover:text-brand-ink cursor-pointer"
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                            </svg>
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 max-w-[180px]">
                      <span className="block truncate text-micro text-fg-muted" title={lead.productName ?? undefined}>
                        {lead.productName ?? <span className="text-fg-faint">-</span>}
                      </span>
                    </td>
                    <td className="num px-4 py-3 whitespace-nowrap text-body font-medium text-fg">
                      {lead.productValue
                        ? (lead.productValue / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
                        : <span className="text-fg-faint">-</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <StatusTag lead={lead} />
                    </td>
                    <td className="num px-4 py-3 whitespace-nowrap text-micro text-fg-subtle">
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

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="scroll-thin w-[calc(100%-2rem)] max-w-lg max-h-[85vh] overflow-y-auto rounded-[var(--r-xl)] border border-line-subtle bg-surface-overlay">
          <DialogHeader>
            <DialogTitle className="text-h2">{editingMessage ? 'Editar mensagem' : 'Nova mensagem'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <label className="block text-label uppercase text-fg-subtle">Tipo</label>
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
                <label className="block text-label uppercase text-fg-subtle">Conteúdo</label>
                <Textarea
                  value={form.content}
                  onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                  placeholder="Digite a mensagem..."
                  className={cn(FIELD, 'min-h-[100px] text-body')}
                />
                <p className="text-micro text-fg-subtle">
                  Variáveis disponíveis: {'{primeiro_nome}'}, {'{nome}'}, {'{produto}'}, {'{valor}'}, {'{boleto_codigo}'}, {'{boleto_url}'}, {'{pix_codigo}'}, {'{link_checkout}'}.
                </p>
                <p className="text-micro text-fg-faint">
                  {'{link_checkout}'} é o link de retomada do checkout, preenchido nos eventos de carrinho abandonado.
                </p>
              </div>
            )}

            {form.messageType === 'interactive_buttons' && (
              <>
                <div className="space-y-1.5">
                  <label className="block text-label uppercase text-fg-subtle">Texto da mensagem</label>
                  <Textarea
                    value={form.content}
                    onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                    placeholder="Texto que aparece acima dos botões..."
                    className={cn(FIELD, 'min-h-[80px] text-body')}
                  />
                </div>
                <div className="space-y-2">
                  <label className="block text-label uppercase text-fg-subtle">Botões (máximo 3)</label>
                  {form.buttons.map((btn, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        value={btn.label}
                        onChange={(e) => setButton(i, e.target.value)}
                        placeholder={`Botão ${i + 1}, até 20 caracteres`}
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
                      <Plus size={12} /> Adicionar botão
                    </button>
                  )}
                  <p className="text-micro text-fg-subtle">Funciona dentro da janela de 24h após o lead responder. API oficial Meta e UazAPI.</p>
                </div>
              </>
            )}

            {form.messageType === 'template' && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="block text-label uppercase text-fg-subtle">Template</label>
                  <Select
                    value={form.templateName}
                    onValueChange={(v) => {
                      const tpl = metaTemplates.find(t => t.name === v)
                      setForm(f => ({ ...f, templateName: v ?? '', templateLanguage: tpl?.language ?? 'pt_BR' }))
                    }}
                    items={Object.fromEntries(metaTemplates.map(t => [t.name, `${t.name} (${t.language})`]))}
                  >
                    <SelectTrigger className={cn(FIELD, CONTROL_H, 'w-full text-body')}>
                      <SelectValue placeholder="Selecione um template..." />
                    </SelectTrigger>
                    <SelectContent className="border border-line-subtle bg-surface-overlay text-fg">
                      {metaTemplates.map(t => (
                        <SelectItem key={t.name} value={t.name}>
                          {t.name} ({t.language})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-micro text-fg-subtle">Apenas templates com status APPROVED aparecem.</p>
                </div>
                <div className="space-y-2">
                  <label className="block text-label uppercase text-fg-subtle">Variáveis do template</label>
                  <p className="text-micro text-fg-subtle">Mapeie cada variável posicional para uma variável do sistema.</p>
                  {[1,2,3,4,5].map(i => (
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
                  <label className="block text-label uppercase text-fg-subtle">URL da mídia</label>
                  <Input
                    value={form.mediaUrl}
                    onChange={(e) => setForm((f) => ({ ...f, mediaUrl: e.target.value }))}
                    placeholder="https://..."
                    className={cn(FIELD, CONTROL_H, 'text-body')}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-label uppercase text-fg-subtle">Legenda</label>
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
                Enviar após quantos minutos do evento?
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
                  <ShieldCheck size={12} className="text-brand-ink" />
                  Antes de enviar, o sistema verifica automaticamente se a pessoa já pagou.
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving} className={cn(CONTROL_H, 'focus-ring px-4')}>
                Cancelar
              </Button>
              <Button onClick={handleSaveMessage} disabled={saving} className={cn(CONTROL_H, 'focus-ring px-4')}>
                {saving ? 'Salvando...' : 'Salvar'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
