'use client'

import { PageHeader } from '@/components/ui/page-header'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  AlertCircle,
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
  Tag,
  CheckCircle2,
  Users,
  Send,
  ArrowLeftRight,
  Minus,
  Plus,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ImportLeadsModal } from '@/components/leads/ImportLeadsModal'
import { AddLeadModal } from '@/components/leads/AddLeadModal'
import { EditLeadModal, type LeadForEdit } from '@/components/leads/EditLeadModal'
import { TemplateSelector, type TemplateSelection } from '@/components/leads/TemplateSelector'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MobileRowCard } from '@/components/ui/mobile-row-card'
import PeriodBar from '@/components/shared/PeriodBar'
import { resolvePeriod } from '@/lib/period'
import { cn } from '@/lib/utils'
import Link from 'next/link'
import { LeadFilterMultiSelect, type LeadFilterOption } from '@/components/leads/LeadFilterMultiSelect'
import type { DispatchEligibility } from '@/lib/mass-dispatch-eligibility'

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
  tags?: string[]
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

const EVENT_TYPE_LABELS: Record<string, string> = {
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

const STATUS_LABELS: Record<string, string> = {
  awaiting_contact: '⏳ Aguardando Abordagem',
  pending: 'Aguardando',
  in_progress: 'Em atendimento',
  converted: 'Convertido / Fechado',
  completed: 'Sem conversão',
  failed: 'Falhou',
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

const SOURCE_LABELS: Record<string, string> = {
  instagram: '📸 Instagram',
  mineracao: '⛏️ Mineração',
  whatsapp: '💬 WhatsApp',
  email: '✉️ E-mail',
  anuncio: '📣 Anúncio',
}

type LeadFilterOptions = {
  eventTypes: string[]
  statuses: string[]
  sources: string[]
  platforms: string[]
  channels: string[]
  products: string[]
  tags: string[]
}

const EMPTY_FILTER_OPTIONS: LeadFilterOptions = {
  eventTypes: [], statuses: [], sources: [], platforms: [], channels: [], products: [], tags: [],
}

function filterLabel(value: string, labels: Record<string, string> = {}) {
  return labels[value] ?? value.replace(/[_-]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase())
}

function filterOptions(values: string[], labels?: Record<string, string>): LeadFilterOption[] {
  return values.map(value => ({ value, label: filterLabel(value, labels) }))
}

const CONTROL_HEIGHT = 'h-[var(--control-lg)] lg:h-[var(--control-md)]'
const FIELD_SKIN = 'bg-surface-inset dark:bg-surface-inset border-line-subtle focus-visible:ring-0 focus-visible:border-line-default'

const COLUMNS: { label: string; className?: string }[] = [
  { label: 'Selecionar', className: 'w-12' },
  { label: 'Nome / Cliente', className: 'w-[260px]' },
  { label: 'Tags', className: 'w-[180px]' },
  { label: 'Telefone / WhatsApp' },
  { label: 'Produto / Oferta', className: 'w-[220px]' },
  { label: 'Valor' },
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

function TagPills({ tags }: { tags?: string[] }) {
  if (!tags?.length) return <span className="text-micro text-fg-faint">-</span>
  return (
    <div className="flex max-w-[180px] flex-wrap gap-1">
      {tags.slice(0, 4).map(tag => <span key={tag} className="max-w-[84px] truncate rounded-full border border-brand-solid/30 bg-brand-glow px-1.5 py-0.5 text-[10px] text-brand-ink" title={tag}>{tag}</span>)}
      {tags.length > 4 && <span className="text-[10px] text-fg-subtle">+{tags.length - 4}</span>}
    </div>
  )
}

const PAGE_SIZE = 50

export default function LeadsPage() {
  const searchParams = useSearchParams()
  const initialList = (key: string) => (searchParams.get(key) ?? '').split(',').map(value => value.trim()).filter(Boolean)

  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)

  // Filtros Básicos
  const [search, setSearch] = useState(() => searchParams.get('search') ?? '')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [selectedEventTypes, setSelectedEventTypes] = useState<string[]>(() => initialList('event_type'))
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>(() => initialList('status'))

  // Os filtros principais ficam no mesmo painel e aceitam OR dentro de cada grupo.
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(true)
  const [selectedProducts, setSelectedProducts] = useState<string[]>(() => initialList('product'))
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>(() => initialList('platform'))
  const [selectedSources, setSelectedSources] = useState<string[]>(() => initialList('source'))
  const [selectedChannels, setSelectedChannels] = useState<string[]>(() => initialList('channel'))
  const [selectedTags, setSelectedTags] = useState<string[]>(() => initialList('tag'))

  // Listas Dinâmicas para os Selects
  const [filterOptionsData, setFilterOptionsData] = useState<LeadFilterOptions>(EMPTY_FILTER_OPTIONS)

  // Paginação
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)

  // Modais
  const [addLeadModalOpen, setAddLeadModalOpen] = useState(false)
  const [importModalOpen, setImportModalOpen] = useState(false)
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [selectedLeadForEdit, setSelectedLeadForEdit] = useState<LeadForEdit | null>(null)
  const [exporting, setExporting] = useState(false)
  const [selectedLeadIds, setSelectedLeadIds] = useState<number[]>([])
  const [selectAllFilter, setSelectAllFilter] = useState(false)
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [templateSelection, setTemplateSelection] = useState<TemplateSelection | null>(null)
  const [creatingDispatch, setCreatingDispatch] = useState(false)
  const [dispatchConfirmed, setDispatchConfirmed] = useState(false)
  const [dispatchFeedback, setDispatchFeedback] = useState<string | null>(null)
  const [dispatchError, setDispatchError] = useState<string | null>(null)
  const [dispatchValidationMessage, setDispatchValidationMessage] = useState<string | null>(null)
  const [dispatchEligibility, setDispatchEligibility] = useState<DispatchEligibility | null>(null)
  const [dispatchEligibilityLoading, setDispatchEligibilityLoading] = useState(false)
  const [dispatchStatus, setDispatchStatus] = useState<{
    batchId: number
    status: string
    deliveryStatus?: string | null
    error?: string | null
    createdAt?: string | null
    confirmedAt?: string | null
    processingStartedAt?: string | null
    sentAt?: string | null
  } | null>(null)
  const [tagActionOpen, setTagActionOpen] = useState(false)
  const [tagAction, setTagAction] = useState<'add' | 'remove' | 'replace'>('add')
  const [tagInput, setTagInput] = useState('')
  const [fromTag, setFromTag] = useState('')
  const [toTag, setToTag] = useState('')
  const [tagPreview, setTagPreview] = useState<{ selectedCount: number; fromTagCount: number | null; withoutFromTagCount: number | null } | null>(null)
  const [tagResult, setTagResult] = useState<{ altered: number; ignored: number; failed: number } | null>(null)
  const [tagLoading, setTagLoading] = useState(false)

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

  // Carrega apenas opções existentes no tenant autenticado.
  useEffect(() => {
    let cancelled = false
    fetch('/api/leads?options_only=true')
      .then(r => r.json())
      .then(data => {
        if (!cancelled && data && typeof data === 'object') {
          setFilterOptionsData({
            ...EMPTY_FILTER_OPTIONS,
            ...Object.fromEntries(Object.keys(EMPTY_FILTER_OPTIONS).map(key => [key, Array.isArray(data[key]) ? data[key].filter((value: unknown): value is string => typeof value === 'string') : []])),
          } as LeadFilterOptions)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
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
    if (selectedEventTypes.length) params.set('event_type', selectedEventTypes.join(','))
    if (selectedStatuses.length) params.set('status', selectedStatuses.join(','))
    if (selectedSources.length) params.set('source', selectedSources.join(','))
    if (selectedProducts.length) params.set('product', selectedProducts.join(','))
    if (selectedPlatforms.length) params.set('platform', selectedPlatforms.join(','))
    if (selectedChannels.length) params.set('channel', selectedChannels.join(','))
    if (selectedTags.length) params.set('tag', selectedTags.join(','))

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
    selectedEventTypes,
    selectedStatuses,
    selectedSources,
    selectedProducts,
    selectedPlatforms,
    selectedChannels,
    selectedTags,
    from,
    to,
  ])

  const dispatchFilter = useMemo(() => ({
    search: debouncedSearch || undefined,
    event_type: selectedEventTypes.length ? selectedEventTypes.join(',') : undefined,
    status: selectedStatuses.length ? selectedStatuses.join(',') : undefined,
    source: selectedSources.length ? selectedSources.join(',') : undefined,
    product: selectedProducts.length ? selectedProducts.join(',') : undefined,
    platform: selectedPlatforms.length ? selectedPlatforms.join(',') : undefined,
    channel: selectedChannels.length ? selectedChannels.join(',') : undefined,
    tag: selectedTags.length ? selectedTags.join(',') : undefined,
    from, to,
  }), [debouncedSearch, selectedEventTypes, selectedStatuses, selectedSources, selectedProducts, selectedPlatforms, selectedChannels, selectedTags, from, to])

  const toggleLead = (id: number) => {
    setSelectAllFilter(false)
    setSelectedLeadIds(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id])
  }
  const togglePage = () => {
    const ids = leads.map(lead => lead.id)
    setSelectAllFilter(false)
    setSelectedLeadIds(previous => ids.every(id => previous.includes(id)) ? previous.filter(id => !ids.includes(id)) : [...new Set([...previous, ...ids])])
  }
  const clearSelection = () => { setSelectedLeadIds([]); setSelectAllFilter(false) }
  const selectionCount = selectAllFilter ? 'Todos os leads filtrados' : `${selectedLeadIds.length} selecionado${selectedLeadIds.length === 1 ? '' : 's'}`
  const dispatchRecipientLabel = selectAllFilter
    ? 'os destinatários selecionados'
    : selectedLeadIds.length === 1
      ? '1 destinatário selecionado'
      : `${selectedLeadIds.length} destinatários selecionados`
  const dispatchPreviewLeads = useMemo(() => {
    const candidates = selectAllFilter ? leads : leads.filter(lead => selectedLeadIds.includes(lead.id))
    const source = candidates.length ? candidates : leads.slice(0, 1)
    return source.map(lead => Object.fromEntries(Object.entries(lead).map(([key, value]) => [key, value == null ? '' : String(value)])))
  }, [leads, selectAllFilter, selectedLeadIds])
  const tagSelection = useMemo(() => ({
    mode: selectAllFilter ? 'filter' : 'ids',
    leadIds: selectAllFilter ? undefined : selectedLeadIds,
    filter: selectAllFilter ? dispatchFilter : undefined,
  }), [selectAllFilter, selectedLeadIds, dispatchFilter])
  const parsedTags = useMemo(() => [...new Set(tagInput.split(',').map(value => value.trim().toLowerCase()).filter(Boolean))], [tagInput])
  const canPreviewTags = tagAction === 'replace' ? Boolean(fromTag.trim() && toTag.trim() && fromTag.trim().toLowerCase() !== toTag.trim().toLowerCase()) : parsedTags.length > 0

  const resetTagAction = () => {
    setTagActionOpen(false)
    setTagPreview(null)
    setTagResult(null)
    setTagInput('')
    setFromTag('')
    setToTag('')
    setTagLoading(false)
  }
  const tagPayload = () => ({
    ...tagSelection,
    action: tagAction,
    tags: parsedTags,
    fromTag: fromTag.trim(),
    toTag: toTag.trim(),
  })
  const previewTags = async () => {
    if (!canPreviewTags) return
    setTagLoading(true)
    setTagResult(null)
    try {
      const response = await fetch('/api/leads/tags/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...tagPayload(), preview: true }) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Não foi possível preparar a prévia.')
      setTagPreview(data)
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Não foi possível preparar a prévia.')
    } finally {
      setTagLoading(false)
    }
  }
  const applyTags = async () => {
    if (!tagPreview) return
    setTagLoading(true)
    try {
      const response = await fetch('/api/leads/tags/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...tagPayload(), confirm: true }) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Não foi possível aplicar as tags.')
      setTagResult({ altered: data.altered ?? 0, ignored: data.ignored ?? 0, failed: data.failed?.length ?? 0 })
      setTagPreview(null)
      clearSelection()
      await fetchLeads(page)
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Não foi possível aplicar as tags.')
    } finally {
      setTagLoading(false)
    }
  }
  const handleTemplateChange = useCallback((selection: TemplateSelection | null) => {
    setTemplateSelection(selection)
    if (!selection) setDispatchConfirmed(false)
    setDispatchError(null)
    setDispatchFeedback(null)
  }, [])
  const validateDispatchSelection = async () => {
    setDispatchEligibility(null)
    setDispatchEligibilityLoading(true)
    setDispatchError(null)
    try {
      const params = new URLSearchParams({ mode: selectAllFilter ? 'filter' : 'ids' })
      if (selectAllFilter) params.set('filter', JSON.stringify(dispatchFilter))
      else params.set('lead_ids', selectedLeadIds.join(','))
      const response = await fetch(`/api/leads/dispatch/validate?${params}`, { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.eligibility) throw new Error(data.error || 'Não foi possível validar os leads selecionados.')
      setDispatchEligibility(data.eligibility as DispatchEligibility)
    } catch (error) {
      setDispatchError(error instanceof Error ? error.message : 'Não foi possível validar os leads selecionados.')
    } finally {
      setDispatchEligibilityLoading(false)
    }
  }
  const openDispatchForSelection = () => {
    setTemplateSelection(null)
    setDispatchConfirmed(false)
    setDispatchFeedback(null)
    setDispatchError(null)
    setDispatchValidationMessage(null)
    setDispatchStatus(null)
    setDispatchOpen(true)
    void validateDispatchSelection()
  }
  const createDispatch = async (action: 'save_draft' | 'start') => {
    // Once the confirmation POST has been accepted, this modal becomes a
    // receipt. Keeping this guard next to the request prevents a stale click
    // or an event replay from creating a second POST for the same composer.
    if (dispatchStatus || dispatchEligibilityLoading || !dispatchEligibility || dispatchEligibility.eligibleCount !== dispatchEligibility.uniqueRequestedCount || !templateSelection || (!selectAllFilter && !selectedLeadIds.length) || (action === 'start' && !dispatchConfirmed)) return
    setCreatingDispatch(true)
    setDispatchError(null)
    setDispatchFeedback(null)
    try {
      const response = await fetch('/api/leads/dispatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, mode: selectAllFilter ? 'filter' : 'ids', leadIds: selectAllFilter ? undefined : selectedLeadIds, filter: selectAllFilter ? dispatchFilter : undefined, template: templateSelection }) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(typeof data.error === 'string' ? `${data.error}${data.batchId ? ` (lote #${data.batchId} permanece em rascunho)` : ''}` : 'Não foi possível iniciar o disparo.')
      setDispatchConfirmed(false)
      if (action === 'start' && Number.isInteger(data.batchId)) {
        setDispatchFeedback(null)
        setDispatchStatus({ batchId: data.batchId, status: 'queued' })
      } else {
        setDispatchFeedback(`Rascunho salvo: lote #${data.batchId}, ${data.recipientCount ?? 0} destinatário(s).`)
      }
      await fetchLeads(page)
    } catch (error) {
      setDispatchError(error instanceof Error ? error.message : 'Não foi possível iniciar o disparo.')
    } finally { setCreatingDispatch(false) }
  }

  useEffect(() => {
    if (!dispatchStatus?.batchId) return
    let cancelled = false
    let timer: number | undefined
    const readStatus = async () => {
      try {
        const response = await fetch(`/api/leads/dispatch/${dispatchStatus.batchId}`)
        const data = await response.json().catch(() => ({}))
        if (!cancelled && response.ok) {
          const jobs = Array.isArray(data.jobs) ? data.jobs : []
          const firstJob = jobs[0]
          const jobError = jobs.find((job: { error?: string | null }) => job.error)?.error ?? null
          const next = {
            batchId: dispatchStatus.batchId,
            status: typeof data.batch?.status === 'string' ? data.batch.status : 'processing',
            deliveryStatus: firstJob?.deliveryStatus ?? null,
            error: jobError,
            createdAt: typeof data.batch?.createdAt === 'string' ? data.batch.createdAt : null,
            confirmedAt: typeof data.batch?.confirmedAt === 'string' ? data.batch.confirmedAt : null,
            processingStartedAt: typeof firstJob?.processingStartedAt === 'string' ? firstJob.processingStartedAt : null,
            sentAt: typeof firstJob?.sentAt === 'string' ? firstJob.sentAt : null,
          }
          setDispatchStatus(next)
          const deliveryTerminal = ['delivered', 'read'].includes(next.deliveryStatus ?? '')
          const processingTerminal = ['failed', 'partial_failure'].includes(next.status) || deliveryTerminal
          if (!processingTerminal) timer = window.setTimeout(() => void readStatus(), 2500)
        }
      } catch {
        if (!cancelled) timer = window.setTimeout(() => void readStatus(), 4000)
      }
    }
    void readStatus()
    return () => { cancelled = true; if (timer) window.clearTimeout(timer) }
  }, [dispatchStatus?.batchId])

  useEffect(() => {
    const timer = window.setTimeout(() => { void fetchLeads(page) }, 0)
    return () => window.clearTimeout(timer)
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
      if (selectedEventTypes.length) params.set('event_type', selectedEventTypes.join(','))
      if (selectedStatuses.length) params.set('status', selectedStatuses.join(','))
      if (selectedSources.length) params.set('source', selectedSources.join(','))
      if (selectedProducts.length) params.set('product', selectedProducts.join(','))
      if (selectedPlatforms.length) params.set('platform', selectedPlatforms.join(','))
      if (selectedChannels.length) params.set('channel', selectedChannels.join(','))
      if (selectedTags.length) params.set('tag', selectedTags.join(','))

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
    setSelectedEventTypes([])
    setSelectedStatuses([])
    setSearch('')
    setDebouncedSearch('')
    setSelectedProducts([])
    setSelectedPlatforms([])
    setSelectedSources([])
    setSelectedChannels([])
    setSelectedTags([])
    setPage(0)
  }

  const hasAdvancedFiltersActive =
    selectedProducts.length > 0 ||
    selectedPlatforms.length > 0 ||
    selectedSources.length > 0 ||
    selectedChannels.length > 0 ||
    selectedTags.length > 0

  const hasAnyFilter =
    selectedEventTypes.length > 0 ||
    selectedStatuses.length > 0 ||
    search.trim().length > 0 ||
    hasAdvancedFiltersActive

  const subtitle = loading
    ? 'Carregando leads no banco de dados...'
    : `Exibindo ${leads.length} ${leads.length === 1 ? 'lead' : 'leads'} ${
        search.trim() ? `para a busca global "${search}"` : `na página ${page + 1}`
      }`

  return (
    <div className="w-full min-w-0 max-w-none space-y-5">
      {selectedSources.length > 0 && (
        <div className="flex items-center gap-2 text-micro">
          <span className="inline-flex items-center gap-1.5 font-semibold text-brand-ink bg-brand-glow px-2.5 py-1 rounded-full border border-brand-solid/30">
            <Target size={12} />
            Filtrando por origem: {selectedSources.map(source => filterLabel(source, SOURCE_LABELS)).join(', ')}
          </span>
          <button type="button" onClick={() => setSelectedSources([])} className="text-fg-subtle hover:text-fg underline underline-offset-2">
            Limpar filtro
          </button>
        </div>
      )}

      {/* Header com Ações */}
      <PageHeader
        icon={<Users size={22} />}
        title="Leads & Contatos"
        description={<>
          {subtitle}
        </>}
        actions={<>
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
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
        </>}
        className="shrink-0"
      />

      {/* Barra de Busca Global e Filtros Principais */}
      <div className="p-3.5 sm:p-4 rounded-xl bg-surface-panel border border-line-subtle space-y-3">
        <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar por nome, WhatsApp ou e-mail..."
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

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(210px,1fr)_minmax(210px,1fr)_auto] sm:items-start">
            <LeadFilterMultiSelect
              label="Status"
              placeholder="Todos os status"
              options={filterOptions(filterOptionsData.statuses, STATUS_LABELS)}
              values={selectedStatuses}
              onChange={values => { setSelectedStatuses(values); setPage(0) }}
            />
            <LeadFilterMultiSelect
              label="Evento / tipo de evento"
              placeholder="Todos os eventos"
              options={filterOptions(filterOptionsData.eventTypes, EVENT_TYPE_LABELS)}
              values={selectedEventTypes}
              onChange={values => { setSelectedEventTypes(values); setPage(0) }}
            />
            <Button
              type="button"
              variant={showAdvancedFilters || hasAdvancedFiltersActive ? "secondary" : "outline"}
              onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
              aria-expanded={showAdvancedFilters}
              aria-controls="leads-filter-panel"
              className={cn(
                "min-h-10 gap-1.5 text-micro font-bold border-line-subtle cursor-pointer",
                hasAdvancedFiltersActive && "border-brand-solid text-brand-ink bg-brand-glow"
              )}
            >
              <SlidersHorizontal size={14} />
              <span>Mais filtros</span>
              {(hasAdvancedFiltersActive || selectedEventTypes.length > 0 || selectedStatuses.length > 0) && <span className="h-2 w-2 rounded-full bg-brand-solid" />}
            </Button>
          </div>
        </div>

        {/* Painel responsivo: no celular ocupa uma coluna e permanece recolhível. */}
        {showAdvancedFilters && (
          <div id="leads-filter-panel" className="grid grid-cols-1 gap-3 border-t border-line-subtle pt-3 sm:grid-cols-2 lg:grid-cols-3 animate-in fade-in duration-150">
            <LeadFilterMultiSelect
              label="Tags"
              placeholder="Todas as tags"
              options={filterOptions(filterOptionsData.tags)}
              values={selectedTags}
              onChange={values => { setSelectedTags(values); setPage(0) }}
            />
            <LeadFilterMultiSelect
              label="Produto / oferta"
              placeholder="Todos os produtos"
              options={filterOptions(filterOptionsData.products)}
              values={selectedProducts}
              onChange={values => { setSelectedProducts(values); setPage(0) }}
            />
            <LeadFilterMultiSelect
              label="Origem"
              placeholder="Todas as origens"
              options={filterOptions(filterOptionsData.sources, SOURCE_LABELS)}
              values={selectedSources}
              onChange={values => { setSelectedSources(values); setPage(0) }}
            />
            <LeadFilterMultiSelect
              label="Plataforma"
              placeholder="Todas as plataformas"
              options={filterOptions(filterOptionsData.platforms)}
              values={selectedPlatforms}
              onChange={values => { setSelectedPlatforms(values); setPage(0) }}
            />
            <LeadFilterMultiSelect
              label="Canal"
              placeholder="Todos os canais"
              options={filterOptions(filterOptionsData.channels)}
              values={selectedChannels}
              onChange={values => { setSelectedChannels(values); setPage(0) }}
            />

            {hasAnyFilter && (
              <div className="flex items-end justify-end pt-1 sm:col-span-2 lg:col-span-3">
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
                <label className="flex items-center gap-2 text-micro text-fg-muted cursor-pointer"><input type="checkbox" checked={selectAllFilter || selectedLeadIds.includes(lead.id)} onChange={() => toggleLead(lead.id)} className="accent-cyan-500" />Selecionar para disparo</label>
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
                      <TagPills tags={lead.tags} />
                      <span>•</span>
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
      <div className="hidden w-full min-w-0 lg:block panel overflow-hidden">
        {!loading && leads.length > 0 && leads.every(lead => selectedLeadIds.includes(lead.id)) && !selectAllFilter && (
          <div className="flex items-center justify-between gap-3 border-b border-cyan-500/30 bg-cyan-500/5 px-4 py-2 text-micro text-cyan-200">
            <span>Todos os {leads.length} leads desta página estão selecionados?</span>
            <Button variant="ghost" size="sm" onClick={() => { setSelectAllFilter(true); setSelectedLeadIds([]) }} className="text-cyan-300 hover:text-cyan-100">Selecionar todos os leads que correspondem ao filtro</Button>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] text-left text-body">
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
                    {col.label === 'Selecionar' ? <input type="checkbox" aria-label="Selecionar todos os leads desta página" checked={leads.length > 0 && leads.every(lead => selectedLeadIds.includes(lead.id)) && !selectAllFilter} onChange={togglePage} className="accent-cyan-500" /> : col.label}
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
                      <td className="px-4 py-3"><input type="checkbox" aria-label={`Selecionar ${lead.name ?? lead.phone}`} checked={selectAllFilter || selectedLeadIds.includes(lead.id)} onChange={() => toggleLead(lead.id)} className="accent-cyan-500" /></td>
                      <td className="px-4 py-3 max-w-[260px]">
                        <p className="font-semibold text-fg truncate">{lead.name ?? 'Cliente'}</p>
                        {lead.email && <p className="text-micro text-fg-subtle truncate">{lead.email}</p>}
                      </td>
                      <td className="px-4 py-3"><TagPills tags={lead.tags} /></td>
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

      <Dialog open={dispatchOpen} onOpenChange={(open) => {
        setDispatchOpen(open)
        if (!open) {
          setTemplateSelection(null)
          setDispatchConfirmed(false)
          setDispatchFeedback(null)
          setDispatchError(null)
          setDispatchValidationMessage(null)
          setDispatchStatus(null)
          setDispatchEligibility(null)
          setDispatchEligibilityLoading(false)
        }
      }}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto bg-surface-panel border-line-subtle">
          <DialogHeader><DialogTitle>{dispatchStatus ? 'Recibo do disparo' : 'Disparar template aprovado'}</DialogTitle></DialogHeader>
          {!dispatchStatus && <p className="text-body text-fg-muted">Destinatários: <strong className="text-fg">{selectionCount}</strong>. Revise a prévia abaixo e confirme o disparo antes de enfileirar.</p>}
          {!dispatchStatus && <TemplateSelector lead={dispatchPreviewLeads[0] ?? {}} leads={dispatchPreviewLeads} onChange={handleTemplateChange} onValidationChange={setDispatchValidationMessage} />}
          {dispatchError && <p role="alert" className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-body text-rose-300"><AlertCircle size={16} className="mt-0.5 shrink-0" />{dispatchError}</p>}
          {dispatchFeedback && <p role="status" className="flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-body text-emerald-300"><CheckCircle2 size={16} className="mt-0.5 shrink-0" />{dispatchFeedback}</p>}
          {!dispatchStatus && dispatchEligibilityLoading && <p role="status" className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3 text-micro text-cyan-100">Validando a seleção antes de permitir o disparo...</p>}
          {!dispatchStatus && dispatchEligibility && <p role="status" className={`rounded-lg border p-3 text-micro ${dispatchEligibility.eligibleCount === dispatchEligibility.uniqueRequestedCount ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-rose-500/40 bg-rose-500/10 text-rose-200'}`}>
            Seleção validada: {dispatchEligibility.eligibleCount} de {dispatchEligibility.uniqueRequestedCount} lead(s) têm telefone elegível.
            {dispatchEligibility.missingCount > 0 && ` ${dispatchEligibility.missingCount} não existem ou não pertencem a esta empresa.`}
            {dispatchEligibility.noPhoneCount > 0 && ` ${dispatchEligibility.noPhoneCount} estão sem telefone elegível.`}
            {dispatchEligibility.duplicateCount > 0 && ` ${dispatchEligibility.duplicateCount} seleção(ões) repetida(s).`}
            {dispatchEligibility.eligibleCount !== dispatchEligibility.uniqueRequestedCount && ' Nenhum envio parcial será permitido; revise a seleção.'}
          </p>}
          {!dispatchStatus && <>
            <label className="flex items-start gap-2.5 rounded-lg border border-line-subtle bg-surface-inset p-3 text-body text-fg cursor-pointer">
              <input type="checkbox" checked={dispatchConfirmed} onChange={event => setDispatchConfirmed(event.target.checked)} className="mt-0.5 h-4 w-4" disabled={!templateSelection || creatingDispatch || dispatchEligibilityLoading || !dispatchEligibility || dispatchEligibility.eligibleCount !== dispatchEligibility.uniqueRequestedCount} aria-describedby={dispatchValidationMessage ? 'dispatch-confirmation-reason' : undefined} />
              <span>Confirmo a prévia e autorizo o envio para {dispatchRecipientLabel}.</span>
            </label>
            {!templateSelection && dispatchValidationMessage && <p id="dispatch-confirmation-reason" role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-micro text-amber-200">{dispatchValidationMessage}</p>}
          </>}
          {dispatchStatus && <div role="status" aria-live="polite" aria-atomic="true" className={`rounded-lg border p-4 ${dispatchStatus.status === 'failed' || dispatchStatus.status === 'partial_failure' ? 'border-rose-500/40 bg-rose-500/10 text-rose-200' : dispatchStatus.deliveryStatus === 'delivered' || dispatchStatus.deliveryStatus === 'read' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-cyan-500/30 bg-cyan-500/5 text-cyan-100'}`}>
            <p className="flex items-center gap-2 text-body font-semibold">
              {dispatchStatus.status === 'failed' || dispatchStatus.status === 'partial_failure' ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}
              {dispatchStatus.deliveryStatus === 'read' ? 'Mensagem lida' : dispatchStatus.deliveryStatus === 'delivered' ? 'Mensagem entregue' : dispatchStatus.deliveryStatus === 'sent' ? 'Mensagem aceita pela Meta' : dispatchStatus.status === 'queued' ? 'Disparo enfileirado' : dispatchStatus.status === 'processing' ? 'Disparo em processamento' : dispatchStatus.status === 'accepted' ? 'Disparo aceito pela Meta' : dispatchStatus.status === 'partial_failure' ? 'Disparo com falha parcial' : 'Disparo falhou'}
            </p>
            <p className="mt-1 text-micro">Lote #{dispatchStatus.batchId}. {dispatchStatus.deliveryStatus === 'delivered' || dispatchStatus.deliveryStatus === 'read' ? 'O envio foi confirmado; este formulário está encerrado para evitar reenvio.' : dispatchStatus.status === 'failed' || dispatchStatus.status === 'partial_failure' ? 'O envio não será repetido por este formulário. Consulte o histórico antes de preparar uma nova ação.' : 'Acompanhe o estado abaixo; não é necessário iniciar novamente.'}</p>
            {dispatchStatus.error && <p className="mt-2 text-micro">Motivo: {dispatchStatus.error}</p>}
            {(dispatchStatus.createdAt || dispatchStatus.sentAt) && <p className="mt-2 text-micro text-fg-subtle">
              {dispatchStatus.createdAt ? `Enfileirado ${new Date(dispatchStatus.createdAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}` : ''}
              {dispatchStatus.sentAt ? ` · Meta respondeu ${new Date(dispatchStatus.sentAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}` : ''}
              {dispatchStatus.deliveryStatus === 'sent' ? ' · aguardando confirmação de entrega' : ''}
            </p>}
          </div>}
          <div className="flex flex-wrap justify-end gap-2 border-t border-line-subtle pt-4">
            {dispatchStatus ? <>
              <Link href={`/disparo-em-massa?batchId=${dispatchStatus.batchId}`} className="inline-flex min-h-11 items-center rounded-md border border-line-subtle px-4 text-micro font-semibold text-fg-muted hover:bg-surface-inset hover:text-fg">Abrir histórico</Link>
              <Button variant="outline" onClick={() => setDispatchOpen(false)}>Fechar</Button>
            </> : <>
              <Button variant="outline" onClick={() => setDispatchOpen(false)} disabled={creatingDispatch}>Cancelar</Button>
              <Button variant="outline" disabled={!templateSelection || creatingDispatch || dispatchEligibilityLoading} onClick={() => void createDispatch('save_draft')}>Salvar rascunho</Button>
              <Button disabled={!templateSelection || !dispatchConfirmed || creatingDispatch || dispatchEligibilityLoading || !dispatchEligibility || dispatchEligibility.eligibleCount !== dispatchEligibility.uniqueRequestedCount} onClick={() => void createDispatch('start')} className="gap-2 bg-cyan-500 text-black hover:bg-cyan-400"><Send size={15} />{creatingDispatch ? 'Iniciando disparo...' : 'Iniciar disparo'}</Button>
            </>}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={tagActionOpen} onOpenChange={(open) => open ? setTagActionOpen(true) : resetTagAction()}>
        <DialogContent className="w-[calc(100%-1.5rem)] max-h-[90vh] max-w-xl overflow-y-auto bg-surface-panel border-line-subtle">
          <DialogHeader><DialogTitle>Alterar tags dos leads selecionados</DialogTitle></DialogHeader>
          <p className="text-micro text-fg-muted">A seleção vem da página Leads. A operação só altera tags e não cria mensagens, campanhas ou jobs.</p>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Ação de tags">
            {([
              ['add', 'Adicionar', Plus],
              ['remove', 'Remover', Minus],
              ['replace', 'Trocar', ArrowLeftRight],
            ] as const).map(([value, label, Icon]) => (
              <button key={value} type="button" onClick={() => { setTagAction(value); setTagPreview(null); setTagResult(null) }} className={cn('flex min-h-11 items-center justify-center gap-2 rounded-lg border px-3 text-micro font-semibold transition-colors', tagAction === value ? 'border-brand-solid bg-brand-glow text-brand-ink' : 'border-line-subtle bg-surface-inset text-fg-muted hover:text-fg')}>
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>

          {tagAction === 'replace' ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-micro font-semibold text-fg">Tag de origem<Input value={fromTag} onChange={event => { setFromTag(event.target.value); setTagPreview(null) }} placeholder="ex.: prospecto" className="mt-1 bg-surface-inset border-line-subtle" /></label>
              <label className="space-y-1 text-micro font-semibold text-fg">Tag de destino<Input value={toTag} onChange={event => { setToTag(event.target.value); setTagPreview(null) }} placeholder="ex.: cliente" className="mt-1 bg-surface-inset border-line-subtle" /></label>
            </div>
          ) : (
            <label className="space-y-1 text-micro font-semibold text-fg">{tagAction === 'add' ? 'Tags para adicionar' : 'Tags para remover'}<Input value={tagInput} onChange={event => { setTagInput(event.target.value); setTagPreview(null) }} placeholder="Separe várias por vírgula" className="mt-1 bg-surface-inset border-line-subtle" /></label>
          )}

          {tagPreview && (
            <div className="rounded-xl border border-brand-solid/30 bg-brand-glow/40 p-3 text-micro text-fg space-y-1">
              <p className="font-semibold">Prévia para {tagPreview.selectedCount} lead{tagPreview.selectedCount === 1 ? '' : 's'}</p>
              {tagAction === 'replace' && <p>{tagPreview.fromTagCount} possuem a tag de origem e {tagPreview.withoutFromTagCount} serão ignorados por não possuí-la.</p>}
              <p className="text-fg-muted">As demais tags de cada lead serão preservadas.</p>
            </div>
          )}
          {tagResult && <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-3 text-micro text-emerald-200">Alterados: {tagResult.altered} · Ignorados: {tagResult.ignored} · Falhas: {tagResult.failed}</div>}

          <div className="flex flex-wrap justify-end gap-2 border-t border-line-subtle pt-4">
            <Button variant="outline" onClick={resetTagAction}>Fechar</Button>
            {!tagPreview && !tagResult && <Button disabled={!canPreviewTags || tagLoading} onClick={() => void previewTags()} className="bg-brand-solid text-on-accent hover:bg-brand-solid/90">{tagLoading ? 'Calculando...' : 'Ver prévia'}</Button>}
            {tagPreview && <Button disabled={tagLoading} onClick={() => void applyTags()} className="bg-brand-solid text-on-accent hover:bg-brand-solid/90">{tagLoading ? 'Aplicando...' : 'Confirmar alteração'}</Button>}
          </div>
        </DialogContent>
      </Dialog>

      {(selectAllFilter || selectedLeadIds.length > 0) && <div className="sticky bottom-3 z-30 mx-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-2 rounded-xl border border-line-subtle bg-surface-overlay px-3 py-2.5 shadow-xl sm:gap-3 sm:px-4"><span className="text-micro font-semibold text-fg">{selectionCount}</span><Button size="sm" onClick={() => { setTagActionOpen(true); setTagResult(null) }} className="gap-1.5 bg-brand-solid text-on-accent hover:bg-brand-solid/90"><Tag size={14} />Alterar tags</Button><Button size="sm" onClick={openDispatchForSelection} className="gap-1.5 bg-cyan-500 text-black hover:bg-cyan-400"><Send size={14} />Disparar Template</Button><Button size="sm" variant="ghost" onClick={clearSelection}>Limpar seleção</Button></div>}
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
