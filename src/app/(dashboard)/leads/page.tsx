'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  Search,
  RefreshCw,
  Inbox,
  X,
  UploadCloud,
  Download,
  UserPlus,
  Target,
  Edit,
  MessageSquare,
  SlidersHorizontal,
  DollarSign,
  Tag,
  CreditCard,
  Layers,
  CheckCircle2,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { ImportLeadsModal } from '@/components/leads/ImportLeadsModal'
import { AddLeadModal } from '@/components/leads/AddLeadModal'
import { EditLeadModal, type LeadForEdit } from '@/components/leads/EditLeadModal'
import { MobileRowCard } from '@/components/ui/mobile-row-card'
import PeriodBar from '@/components/shared/PeriodBar'
import { resolvePeriod } from '@/lib/period'
import { cn } from '@/lib/utils'
import Link from 'next/link'

interface Lead extends LeadForEdit {
  id: number
  phone: string
  name: string | null
  email: string | null
  productName: string | null
  productValue: number | null
  paymentType: string | null
  eventType: string
  status: string | null
  convertedFrom?: string | null
  platform: string | null
  transactionId?: string | null
  createdAt: string | null
}

const eventLabels: Record<string, string> = {
  mentoria: 'Mentoria',
  aulas: 'Aulas / Curso',
  projeto_individual: 'Projeto Individual',
  consultoria: 'Consultoria',
  workshop: 'Workshop / Imersão',
  assinatura: 'Assinatura',
  prospeccao: 'Prospecção',
  boleto: 'Boleto',
  pix: 'Pix',
  carrinho_abandonado: 'Carrinho',
  cartao_recusado: 'Cartão Recusado',
  compra_aprovada: 'Compra Aprovada',
}

const EVENT_TYPE_OPTIONS: Record<string, string> = {
  all: 'Todos os tipos de evento',
  mentoria: '🎓 Mentoria',
  aulas: '📚 Aulas / Cursos',
  projeto_individual: '💼 Projeto Individual',
  consultoria: '💡 Consultoria',
  workshop: '🎟️ Workshop / Imersão',
  assinatura: '⭐ Assinatura',
  prospeccao: '🎯 Prospecção',
  boleto: 'Boleto',
  pix: 'Pix',
  carrinho_abandonado: 'Carrinho Abandonado',
  cartao_recusado: 'Cartão Recusado',
  compra_aprovada: 'Compra Aprovada',
}

const STATUS_OPTIONS: Record<string, string> = {
  all: 'Todos os status',
  awaiting_contact: '⏳ Aguardando Abordagem',
  pending: 'Aguardando',
  in_progress: 'Em atendimento',
  converted: 'Convertido / Fechado',
  completed: 'Sem conversão',
  failed: 'Falhou',
}

const PAYMENT_OPTIONS: Record<string, string> = {
  all: 'Todas as formas de pagamento',
  pix: '⚡ Pix',
  cartao_credito: '💳 Cartão de Crédito',
  boleto: '📄 Boleto',
  debit_card: '💳 Cartão de Débito',
  paypal: 'PayPal',
}

const SALE_FILTER_OPTIONS: Record<string, string> = {
  all: 'Vendas & Leads (Todos)',
  true: '💰 Apenas Vendas Fechadas',
  false: '👥 Apenas Leads (Não convertidos)',
}

const HAS_FILTER_OPTIONS: Record<string, string> = {
  all: 'Qualquer contato',
  has_phone: '📱 Somente com Telefone',
  has_email: '✉️ Somente com E-mail',
  has_tags: '🏷️ Somente com Tags',
}

const eventDot: Record<string, string> = {
  mentoria: 'text-purple-400',
  aulas: 'text-sky-400',
  projeto_individual: 'text-amber-400',
  consultoria: 'text-indigo-400',
  workshop: 'text-pink-400',
  assinatura: 'text-emerald-400',
  prospeccao: 'text-cyan-400',
  boleto: 'text-ev-boleto',
  pix: 'text-ev-pix',
  carrinho_abandonado: 'text-ev-carrinho',
  cartao_recusado: 'text-ev-cartao',
  compra_aprovada: 'text-ev-aprovada',
}

const SOURCE_FILTER_LABELS: Record<string, string> = {
  instagram: '📸 Instagram',
  mineracao: '⛏️ Mineração',
  whatsapp: '💬 WhatsApp',
  email: '✉️ E-mail',
  anuncio: '📣 Anúncio',
}

const paymentLabels: Record<string, string> = {
  boleto: 'Boleto',
  pix: 'Pix',
  credit_card: 'Cartão de Crédito',
  cartao_credito: 'Cartão de Crédito',
  debit_card: 'Cartão de Débito',
  paypal: 'PayPal',
}

const CONTROL_HEIGHT = 'h-[var(--control-lg)] lg:h-[var(--control-md)]'
const SELECT_HEIGHT = 'data-[size=default]:h-[var(--control-lg)] lg:data-[size=default]:h-[var(--control-md)]'
const FIELD_SKIN = 'bg-surface-inset dark:bg-surface-inset border-line-subtle focus-visible:ring-0 focus-visible:border-line-default'

const COLUMNS: { label: string; className?: string }[] = [
  { label: 'Nome / Cliente', className: 'w-[260px]' },
  { label: 'Telefone / WhatsApp' },
  { label: 'Produto / Oferta', className: 'w-[220px]' },
  { label: 'Valor' },
  { label: 'Pagamento' },
  { label: 'Evento' },
  { label: 'Status' },
  { label: 'Data' },
  { label: 'Ações', className: 'text-right w-24' },
]

function getStatusLabel(status: string | null, eventType: string, convertedFrom?: string | null): string {
  const isRecovery = ['boleto', 'pix', 'carrinho_abandonado', 'cartao_recusado'].includes(eventType)

  if (status === 'converted') {
    if (!convertedFrom || convertedFrom === 'webhook') return 'Pagou sozinho'
    const num = convertedFrom.replace('msg_', '')
    return `Recuperado (msg ${num})`
  }
  if (status === 'completed') {
    return isRecovery ? 'Sem conversão' : 'Confirmada'
  }
  if (status === 'in_progress') return 'Em atendimento'
  if (status === 'failed') return 'Falhou'
  return 'Aguardando'
}

function getStatusDot(status: string | null, convertedFrom?: string | null): string {
  if (status === 'converted') {
    if (!convertedFrom || convertedFrom === 'webhook') return 'text-st-info'
    return 'text-st-positivo'
  }
  if (status === 'completed') return 'text-fg-faint'
  if (status === 'in_progress') return 'text-st-info'
  if (status === 'failed') return 'text-st-negativo'
  return 'text-st-atencao'
}

function fmtCurrency(cents: number | null): string {
  if (!cents) return '-'
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function WhatsAppGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  )
}

const PAGE_SIZE = 50

export default function LeadsPage() {
  const searchParams = useSearchParams()
  const initialStatus = searchParams.get('status') || 'all'
  const sourceParam = searchParams.get('source') || ''

  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)

  // Filtros Básicos
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [eventType, setEventType] = useState('all')
  const [status, setStatus] = useState(initialStatus)

  // Filtros Avançados solicitados
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false)
  const [productFilter, setProductFilter] = useState('all')
  const [platformFilter, setPlatformFilter] = useState('all')
  const [paymentFilter, setPaymentFilter] = useState('all')
  const [tagFilter, setTagFilter] = useState('')
  const [debouncedTag, setDebouncedTag] = useState('')
  const [isSaleFilter, setIsSaleFilter] = useState('all')
  const [hasFilter, setHasFilter] = useState('all')
  const [minValue, setMinValue] = useState('')
  const [maxValue, setMaxValue] = useState('')
  const [transactionIdFilter, setTransactionIdFilter] = useState('')

  // Listas Dinâmicas para os Selects
  const [availableProducts, setAvailableProducts] = useState<string[]>([])
  const [availablePlatforms, setAvailablePlatforms] = useState<string[]>([])

  // Paginação
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)

  // Modais
  const [addLeadModalOpen, setAddLeadModalOpen] = useState(false)
  const [importModalOpen, setImportModalOpen] = useState(false)
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [selectedLeadForEdit, setSelectedLeadForEdit] = useState<LeadForEdit | null>(null)
  const [exporting, setExporting] = useState(false)

  const { from, to } = resolvePeriod({
    from: searchParams.get('from') ?? undefined,
    to: searchParams.get('to') ?? undefined,
  })

  // Debounce para Busca Textual Global
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(0)
    }, 380)
    return () => clearTimeout(handler)
  }, [search])

  // Debounce para Tag
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedTag(tagFilter)
      setPage(0)
    }, 400)
    return () => clearTimeout(handler)
  }, [tagFilter])

  // Carrega lista dinâmica de produtos e plataformas distintos
  useEffect(() => {
    fetch('/api/leads?products_only=true')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) setAvailableProducts(data)
      })
      .catch(() => {})

    fetch('/api/leads?platforms_only=true')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) setAvailablePlatforms(data)
      })
      .catch(() => {})
  }, [])

  // Busca de Leads Global no Banco de Dados
  const fetchLeads = useCallback(async (pg: number) => {
    setLoading(true)
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE + 1),
      offset: String(pg * PAGE_SIZE),
      from,
      to,
    })

    if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim())
    if (eventType !== 'all') params.set('event_type', eventType)
    if (status !== 'all') params.set('status', status)
    if (sourceParam) params.set('source', sourceParam)
    if (productFilter !== 'all') params.set('product', productFilter)
    if (platformFilter !== 'all') params.set('platform', platformFilter)
    if (paymentFilter !== 'all') params.set('payment_type', paymentFilter)
    if (debouncedTag.trim()) params.set('tag', debouncedTag.trim())
    if (isSaleFilter !== 'all') params.set('is_sale', isSaleFilter)
    if (hasFilter === 'has_phone') params.set('has_phone', 'true')
    if (hasFilter === 'has_email') params.set('has_email', 'true')
    if (hasFilter === 'has_tags') params.set('has_tags', 'true')
    if (minValue.trim()) params.set('min_value', minValue.trim())
    if (maxValue.trim()) params.set('max_value', maxValue.trim())
    if (transactionIdFilter.trim()) params.set('transaction_id', transactionIdFilter.trim())

    try {
      const data = await fetch(`/api/leads?${params}`).then(r => r.json())
      const rows: Lead[] = Array.isArray(data) ? data : []
      setHasMore(rows.length > PAGE_SIZE)
      setLeads(rows.slice(0, PAGE_SIZE))
    } catch {
      setLeads([])
    } finally {
      setLoading(false)
    }
  }, [
    debouncedSearch,
    eventType,
    status,
    sourceParam,
    productFilter,
    platformFilter,
    paymentFilter,
    debouncedTag,
    isSaleFilter,
    hasFilter,
    minValue,
    maxValue,
    transactionIdFilter,
    from,
    to,
  ])

  useEffect(() => {
    fetchLeads(page)
  }, [fetchLeads, page])

  function handlePage(dir: number) {
    const next = page + dir
    setPage(next)
  }

  async function exportCSV() {
    setExporting(true)
    try {
      const params = new URLSearchParams({
        export: 'csv',
        from,
        to,
      })

      if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim())
      if (eventType !== 'all') params.set('event_type', eventType)
      if (status !== 'all') params.set('status', status)
      if (sourceParam) params.set('source', sourceParam)
      if (productFilter !== 'all') params.set('product', productFilter)
      if (platformFilter !== 'all') params.set('platform', platformFilter)
      if (paymentFilter !== 'all') params.set('payment_type', paymentFilter)
      if (debouncedTag.trim()) params.set('tag', debouncedTag.trim())
      if (isSaleFilter !== 'all') params.set('is_sale', isSaleFilter)
      if (hasFilter === 'has_phone') params.set('has_phone', 'true')
      if (hasFilter === 'has_email') params.set('has_email', 'true')
      if (hasFilter === 'has_tags') params.set('has_tags', 'true')
      if (minValue.trim()) params.set('min_value', minValue.trim())
      if (maxValue.trim()) params.set('max_value', maxValue.trim())
      if (transactionIdFilter.trim()) params.set('transaction_id', transactionIdFilter.trim())

      const res = await fetch(`/api/leads?${params}`)
      if (!res.ok) throw new Error('Falha ao exportar CSV de leads.')

      const blob = await res.blob()
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `leads_export_${new Date().toISOString().split('T')[0]}.csv`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)
    } catch {
      alert('Erro ao exportar leads. Tente novamente.')
    } finally {
      setExporting(false)
    }
  }

  function clearFilters() {
    setEventType('all')
    setStatus('all')
    setSearch('')
    setDebouncedSearch('')
    setProductFilter('all')
    setPlatformFilter('all')
    setPaymentFilter('all')
    setTagFilter('')
    setDebouncedTag('')
    setIsSaleFilter('all')
    setHasFilter('all')
    setMinValue('')
    setMaxValue('')
    setTransactionIdFilter('')
    setPage(0)
  }

  const hasAdvancedFiltersActive =
    productFilter !== 'all' ||
    platformFilter !== 'all' ||
    paymentFilter !== 'all' ||
    tagFilter.trim().length > 0 ||
    isSaleFilter !== 'all' ||
    hasFilter !== 'all' ||
    minValue.trim().length > 0 ||
    maxValue.trim().length > 0 ||
    transactionIdFilter.trim().length > 0

  const hasAnyFilter =
    eventType !== 'all' ||
    status !== 'all' ||
    search.trim().length > 0 ||
    hasAdvancedFiltersActive

  const subtitle = loading
    ? 'Carregando leads no banco de dados...'
    : `Exibindo ${leads.length} ${leads.length === 1 ? 'lead' : 'leads'} ${
        search.trim() ? `para a busca global "${search}"` : `na página ${page + 1}`
      }`

  const clearSourceHref = (() => {
    const params = new URLSearchParams(searchParams.toString())
    params.delete('source')
    const qs = params.toString()
    return qs ? `/leads?${qs}` : '/leads'
  })()

  return (
    <div className="space-y-5">
      {sourceParam && (
        <div className="flex items-center gap-2 text-micro">
          <span className="inline-flex items-center gap-1.5 font-semibold text-brand-ink bg-brand-glow px-2.5 py-1 rounded-full border border-brand-solid/30">
            <Target size={12} />
            Filtrando por origem: {SOURCE_FILTER_LABELS[sourceParam] ?? sourceParam}
          </span>
          <Link href={clearSourceHref} className="text-fg-subtle hover:text-fg underline underline-offset-2">
            Limpar filtro
          </Link>
        </div>
      )}

      {/* Header com Ações */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-h1 text-fg">Leads & Contatos</h1>
          <p className="text-body text-fg-muted mt-1">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            onClick={() => setAddLeadModalOpen(true)}
            className="shrink-0 gap-1.5 bg-brand-solid hover:bg-brand-solid/90 text-on-accent font-bold text-micro shadow-sm cursor-pointer"
          >
            <UserPlus size={15} />
            + Novo Lead
          </Button>
          <Button
            onClick={() => setImportModalOpen(true)}
            className="shrink-0 gap-1.5 bg-cyan-500 hover:bg-cyan-400 text-black font-bold text-micro cursor-pointer"
          >
            <UploadCloud size={15} />
            Importar Planilha
          </Button>
          <Button
            variant="outline"
            onClick={exportCSV}
            disabled={exporting}
            className="shrink-0 gap-1.5 text-micro border-line-subtle text-fg hover:bg-surface-raised cursor-pointer"
          >
            {exporting ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
            {exporting ? 'Exportando todos...' : 'Exportar CSV'}
          </Button>
          <PeriodBar from={from} to={to} />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fetchLeads(page)}
            className="shrink-0 gap-2 text-fg-muted hover:text-fg cursor-pointer"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Atualizar
          </Button>
        </div>
      </div>

      {/* Barra de Busca Global e Filtros Principais */}
      <div className="p-3.5 sm:p-4 rounded-xl bg-surface-panel border border-line-subtle space-y-3">
        <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center">
          <div className="relative flex-1 min-w-[240px]">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar no banco por Nome, WhatsApp, E-mail, Produto ou Transação..."
              aria-label="Buscar leads globalmente"
              className={`${FIELD_SKIN} ${CONTROL_HEIGHT} pl-9 text-base lg:text-sm`}
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                aria-label="Limpar busca"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg p-1 cursor-pointer"
              >
                <X size={14} />
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 sm:flex sm:gap-2.5 flex-wrap">
            <Select value={eventType} onValueChange={v => { if (v) { setEventType(v); setPage(0); } }} items={EVENT_TYPE_OPTIONS}>
              <SelectTrigger aria-label="Filtrar por evento" className={`${FIELD_SKIN} ${SELECT_HEIGHT} min-w-0 sm:w-48 text-micro font-medium`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-surface-overlay border-line-subtle">
                {Object.entries(EVENT_TYPE_OPTIONS).map(([val, label]) => (
                  <SelectItem key={val} value={val}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={status} onValueChange={v => { if (v) { setStatus(v); setPage(0); } }} items={STATUS_OPTIONS}>
              <SelectTrigger aria-label="Filtrar por status" className={`${FIELD_SKIN} ${SELECT_HEIGHT} min-w-0 sm:w-44 text-micro font-medium`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-surface-overlay border-line-subtle">
                {Object.entries(STATUS_OPTIONS).map(([val, label]) => (
                  <SelectItem key={val} value={val}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              type="button"
              variant={showAdvancedFilters || hasAdvancedFiltersActive ? "secondary" : "outline"}
              onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
              className={cn(
                "gap-1.5 text-micro font-bold border-line-subtle cursor-pointer",
                hasAdvancedFiltersActive && "border-brand-solid text-brand-ink bg-brand-glow"
              )}
            >
              <SlidersHorizontal size={14} />
              <span>Filtros Avançados</span>
              {hasAdvancedFiltersActive && (
                <span className="h-2 w-2 rounded-full bg-brand-solid" />
              )}
            </Button>
          </div>
        </div>

        {/* Painel Expansível de Filtros Avançados */}
        {showAdvancedFilters && (
          <div className="pt-3 border-t border-line-subtle grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 animate-in fade-in duration-150">
            {/* Produto */}
            <div className="space-y-1">
              <label className="text-[11px] font-semibold text-fg-subtle flex items-center gap-1">
                <Layers size={11} /> Produto em Lista
              </label>
              <select
                value={productFilter}
                onChange={e => { setProductFilter(e.target.value); setPage(0); }}
                className="w-full bg-surface-inset border border-line-subtle rounded-lg px-2.5 py-1.5 text-micro text-fg focus:outline-none"
              >
                <option value="all">Todos os produtos ({availableProducts.length})</option>
                {availableProducts.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>

            {/* Plataforma */}
            <div className="space-y-1">
              <label className="text-[11px] font-semibold text-fg-subtle flex items-center gap-1">
                <Target size={11} /> Plataforma (Kiwify, Hotmart, etc.)
              </label>
              <select
                value={platformFilter}
                onChange={e => { setPlatformFilter(e.target.value); setPage(0); }}
                className="w-full bg-surface-inset border border-line-subtle rounded-lg px-2.5 py-1.5 text-micro text-fg focus:outline-none"
              >
                <option value="all">Todas as plataformas</option>
                <option value="import_planilha">📥 Importação de Planilha</option>
                <option value="kiwify">🥝 Kiwify</option>
                <option value="hotmart">🔥 Hotmart</option>
                <option value="greenn">🌿 Greenn</option>
                <option value="zouti">⚡ Zouti</option>
                <option value="instagram">📸 Instagram</option>
                <option value="sac">💬 WhatsApp SAC</option>
                {availablePlatforms.filter(p => !['import_planilha','kiwify','hotmart','greenn','zouti','instagram','sac'].includes(p)).map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>

            {/* Forma de Pagamento */}
            <div className="space-y-1">
              <label className="text-[11px] font-semibold text-fg-subtle flex items-center gap-1">
                <CreditCard size={11} /> Forma de Pagamento
              </label>
              <select
                value={paymentFilter}
                onChange={e => { setPaymentFilter(e.target.value); setPage(0); }}
                className="w-full bg-surface-inset border border-line-subtle rounded-lg px-2.5 py-1.5 text-micro text-fg focus:outline-none"
              >
                {Object.entries(PAYMENT_OPTIONS).map(([val, label]) => (
                  <option key={val} value={val}>{label}</option>
                ))}
              </select>
            </div>

            {/* Venda vs Lead */}
            <div className="space-y-1">
              <label className="text-[11px] font-semibold text-fg-subtle flex items-center gap-1">
                <CheckCircle2 size={11} /> Conversão / Venda
              </label>
              <select
                value={isSaleFilter}
                onChange={e => { setIsSaleFilter(e.target.value); setPage(0); }}
                className="w-full bg-surface-inset border border-line-subtle rounded-lg px-2.5 py-1.5 text-micro text-fg focus:outline-none"
              >
                {Object.entries(SALE_FILTER_OPTIONS).map(([val, label]) => (
                  <option key={val} value={val}>{label}</option>
                ))}
              </select>
            </div>

            {/* Filtro por Tags */}
            <div className="space-y-1">
              <label className="text-[11px] font-semibold text-fg-subtle flex items-center gap-1">
                <Tag size={11} /> Filtrar por Tag
              </label>
              <Input
                value={tagFilter}
                onChange={e => setTagFilter(e.target.value)}
                placeholder="Ex: vip, qualificado, retorno..."
                className="h-8 bg-surface-inset border-line-subtle text-micro"
              />
            </div>

            {/* Somente com... */}
            <div className="space-y-1">
              <label className="text-[11px] font-semibold text-fg-subtle flex items-center gap-1">
                Requisitos de Contato
              </label>
              <select
                value={hasFilter}
                onChange={e => { setHasFilter(e.target.value); setPage(0); }}
                className="w-full bg-surface-inset border border-line-subtle rounded-lg px-2.5 py-1.5 text-micro text-fg focus:outline-none"
              >
                {Object.entries(HAS_FILTER_OPTIONS).map(([val, label]) => (
                  <option key={val} value={val}>{label}</option>
                ))}
              </select>
            </div>

            {/* ID Transação */}
            <div className="space-y-1">
              <label className="text-[11px] font-semibold text-fg-subtle">
                ID da Transação / Pedido
              </label>
              <Input
                value={transactionIdFilter}
                onChange={e => { setTransactionIdFilter(e.target.value); setPage(0); }}
                placeholder="Ex: HP12345678"
                className="h-8 bg-surface-inset border-line-subtle text-micro font-mono"
              />
            </div>

            {/* Faixa de Valor */}
            <div className="space-y-1">
              <label className="text-[11px] font-semibold text-fg-subtle flex items-center gap-1">
                <DollarSign size={11} /> Faixa de Valor (R$)
              </label>
              <div className="flex items-center gap-1.5">
                <Input
                  value={minValue}
                  onChange={e => { setMinValue(e.target.value); setPage(0); }}
                  placeholder="Mín"
                  className="h-8 bg-surface-inset border-line-subtle text-micro font-mono"
                />
                <span className="text-fg-subtle text-xs">-</span>
                <Input
                  value={maxValue}
                  onChange={e => { setMaxValue(e.target.value); setPage(0); }}
                  placeholder="Máx"
                  className="h-8 bg-surface-inset border-line-subtle text-micro font-mono"
                />
              </div>
            </div>

            {hasAnyFilter && (
              <div className="sm:col-span-2 lg:col-span-4 flex justify-end pt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  className="text-micro text-red-400 hover:text-red-300 hover:bg-red-500/10 cursor-pointer h-7"
                >
                  <X size={12} className="mr-1" /> Limpar todos os filtros
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Lista Mobile */}
      <div className="space-y-2 lg:hidden">
        {loading ? (
          <div className="panel flex items-center justify-center p-8 text-fg-muted">
            <RefreshCw size={16} className="animate-spin mr-2" /> Carregando leads no banco...
          </div>
        ) : leads.length === 0 ? (
          <EmptyState hasFilters={hasAnyFilter} onClear={clearFilters} />
        ) : (
          leads.map(lead => {
            const dot = getStatusDot(lead.status, lead.convertedFrom)
            const label = getStatusLabel(lead.status, lead.eventType, lead.convertedFrom)
            const evColor = eventDot[lead.eventType] ?? 'text-fg-faint'
            const evLabel = eventLabels[lead.eventType] ?? lead.eventType
            return (
              <div key={lead.id} className="rounded-xl border border-line-subtle bg-surface-panel p-3 space-y-2 shadow-xs">
                <MobileRowCard
                  title={lead.name ?? 'Cliente'}
                  subtitle={lead.phone}
                  href={`/inbox/${lead.id}`}
                  badges={
                    <span className="text-micro font-semibold text-fg">
                      {fmtCurrency(lead.productValue)}
                    </span>
                  }
                  meta={
                    <>
                      <span className="truncate">{lead.productName ?? '-'}</span>
                      <span>•</span>
                      <span className={`inline-flex items-center gap-1 text-micro text-fg`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${evColor} bg-current`} />
                        {evLabel}
                      </span>
                      <span>•</span>
                      <span className={`inline-flex items-center gap-1 text-micro text-fg`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${dot} bg-current`} />
                        {label}
                      </span>
                    </>
                  }
                />

                <div className="flex items-center justify-between pt-2 border-t border-line-subtle/40">
                  <span className="text-[10px] text-fg-subtle font-mono">
                    ID #{lead.id}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSelectedLeadForEdit(lead)
                        setEditModalOpen(true)
                      }}
                      className="h-7 px-2.5 text-micro font-semibold text-brand-ink border-line-subtle gap-1 cursor-pointer"
                    >
                      <Edit size={12} /> Editar Lead
                    </Button>
                    <Link
                      href={`/inbox/${lead.id}`}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-micro font-semibold text-fg hover:text-brand-ink bg-surface-inset transition-colors"
                    >
                      <MessageSquare size={12} /> Conversa
                    </Link>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Tabela Desktop */}
      <div className="hidden lg:block panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-body">
            <thead>
              <tr className="border-b border-line-subtle">
                {COLUMNS.map(col => (
                  <th
                    key={col.label}
                    className={cn(
                      'px-4 py-3 text-label uppercase text-fg-subtle font-semibold whitespace-nowrap',
                      col.className
                    )}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={COLUMNS.length} className="text-center py-12 text-fg-muted">
                    <RefreshCw size={16} className="inline animate-spin mr-2" /> Consultando leads no banco de dados...
                  </td>
                </tr>
              ) : leads.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length} className="py-6">
                    <EmptyState hasFilters={hasAnyFilter} onClear={clearFilters} />
                  </td>
                </tr>
              ) : (
                leads.map(lead => {
                  const isRecovered = lead.status === 'converted' && lead.convertedFrom && lead.convertedFrom !== 'webhook'
                  const dot = getStatusDot(lead.status, lead.convertedFrom)
                  const label = getStatusLabel(lead.status, lead.eventType, lead.convertedFrom)
                  const evColor = eventDot[lead.eventType] ?? 'text-fg-faint'
                  const evLabel = eventLabels[lead.eventType] ?? lead.eventType
                  return (
                    <tr
                      key={lead.id}
                      className={cn(
                        'group border-b border-line-subtle last:border-0 hover:bg-surface-raised transition-colors',
                        isRecovered && 'bg-st-positivo/5'
                      )}
                    >
                      <td className="px-4 py-3 max-w-[260px]">
                        <p className="font-semibold text-fg truncate">{lead.name ?? 'Cliente'}</p>
                        {lead.email && <p className="text-micro text-fg-subtle truncate">{lead.email}</p>}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <Link
                          href={`/inbox/${lead.id}`}
                          className="inline-flex items-center gap-1.5 font-mono text-micro font-medium text-fg hover:text-brand-ink transition-colors"
                        >
                          <span className="text-brand-ink">
                            <WhatsAppGlyph size={14} />
                          </span>
                          {lead.phone}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-fg-subtle max-w-[220px] truncate">
                        {lead.productName ?? '-'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-fg font-medium">
                        {fmtCurrency(lead.productValue)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-micro text-fg-subtle">
                        {paymentLabels[lead.paymentType ?? ''] ?? lead.paymentType ?? '-'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5 text-micro text-fg">
                          <span className={`h-1.5 w-1.5 rounded-full ${evColor} bg-current`} />
                          {evLabel}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5 text-micro text-fg">
                          <span className={`h-1.5 w-1.5 rounded-full ${dot} bg-current`} />
                          {label}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-micro text-fg-subtle">
                        {lead.createdAt ? new Date(lead.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '-'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setSelectedLeadForEdit(lead)
                              setEditModalOpen(true)
                            }}
                            className="h-8 px-2.5 text-micro font-semibold text-fg hover:text-brand-ink hover:bg-surface-panel border-line-subtle gap-1 cursor-pointer"
                            title="Editar contato e dados do lead"
                          >
                            <Edit size={13} />
                            <span>Editar</span>
                          </Button>
                          <Link
                            href={`/inbox/${lead.id}`}
                            className="p-1.5 text-fg-subtle hover:text-brand-ink hover:bg-surface-panel rounded-lg transition-colors border border-transparent hover:border-line-subtle"
                            title="Abrir no Inbox"
                          >
                            <MessageSquare size={14} />
                          </Link>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Paginação */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-line-subtle">
          <span className="text-micro text-fg-subtle">
            {leads.length} lead{leads.length !== 1 ? 's' : ''} {debouncedSearch ? `encontrado(s) para "${debouncedSearch}"` : `na página ${page + 1}`}
          </span>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={page === 0}
              onClick={() => handlePage(-1)}
              className="min-h-11 lg:min-h-0 px-4 lg:px-3 text-fg-muted hover:text-fg cursor-pointer disabled:opacity-40"
            >
              Anterior
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!hasMore}
              onClick={() => handlePage(1)}
              className="min-h-11 lg:min-h-0 px-4 lg:px-3 text-fg-muted hover:text-fg cursor-pointer disabled:opacity-40"
            >
              Próxima
            </Button>
          </div>
        </div>
      </div>

      {/* Modais de Cadastro, Edição e Importação */}
      <AddLeadModal
        open={addLeadModalOpen}
        onOpenChange={setAddLeadModalOpen}
        onSuccess={() => fetchLeads(page)}
      />
      <ImportLeadsModal
        open={importModalOpen}
        onOpenChange={setImportModalOpen}
        onSuccess={() => fetchLeads(page)}
      />
      <EditLeadModal
        lead={selectedLeadForEdit}
        open={editModalOpen}
        onOpenChange={setEditModalOpen}
        onSuccess={() => fetchLeads(page)}
      />
    </div>
  )
}

function EmptyState({ hasFilters, onClear }: { hasFilters: boolean; onClear: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-inset text-fg-faint">
        <Inbox size={20} />
      </span>
      <div className="space-y-1">
        <p className="text-h2 text-fg">Nenhum lead encontrado</p>
        <p className="text-body text-fg-muted max-w-[46ch]">
          {hasFilters
            ? 'Nenhum registro corresponde aos filtros selecionados. Tente ajustar os termos de busca ou limpar os filtros.'
            : 'Assim que uma plataforma enviar o primeiro webhook ou você cadastrar manualmente, os leads aparecerão nesta lista.'}
        </p>
      </div>
      {hasFilters && (
        <Button variant="outline" size="sm" onClick={onClear} className="mt-1 min-h-9 text-fg-muted hover:text-fg cursor-pointer">
          Limpar todos os filtros
        </Button>
      )}
    </div>
  )
}
