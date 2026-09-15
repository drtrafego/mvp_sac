'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { Search, RefreshCw, Inbox, X, UploadCloud, Download, UserPlus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { ImportLeadsModal } from '@/components/leads/ImportLeadsModal'
import { AddLeadModal } from '@/components/leads/AddLeadModal'
import { MobileRowCard } from '@/components/ui/mobile-row-card'
import PeriodBar from '@/components/shared/PeriodBar'
import { resolvePeriod } from '@/lib/period'
import { cn } from '@/lib/utils'
import Link from 'next/link'

interface Lead {
  id: number
  phone: string
  name: string | null
  email: string | null
  productName: string | null
  productValue: number | null
  paymentType: string | null
  eventType: string
  status: string | null
  convertedFrom: string | null
  platform: string | null
  transactionId: string | null
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
  all: 'Todos os tipos',
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
  pending: 'Aguardando',
  in_progress: 'Em recuperação',
  completed: 'Sem conversão',
  converted: 'Convertido',
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

const paymentLabels: Record<string, string> = {
  boleto: 'Boleto',
  pix: 'Pix',
  credit_card: 'Cartão de Crédito',
  debit_card: 'Cartão de Débito',
  paypal: 'PayPal',
}

const CONTROL_HEIGHT = 'h-[var(--control-lg)] lg:h-[var(--control-md)]'
const SELECT_HEIGHT = 'data-[size=default]:h-[var(--control-lg)] lg:data-[size=default]:h-[var(--control-md)]'
const FIELD_SKIN = 'bg-surface-inset dark:bg-surface-inset border-line-subtle focus-visible:ring-0 focus-visible:border-line-default'

const COLUMNS: { label: string; className?: string }[] = [
  { label: 'Nome', className: 'w-[280px]' },
  { label: 'Telefone' },
  { label: 'Produto', className: 'w-[240px]' },
  { label: 'Valor' },
  { label: 'Pagamento' },
  { label: 'Evento' },
  { label: 'Status' },
  { label: 'Data' },
]

function getStatusLabel(status: string | null, eventType: string, convertedFrom: string | null): string {
  const isRecovery = ['boleto', 'pix', 'carrinho_abandonado', 'cartao_recusado'].includes(eventType)

  if (status === 'converted') {
    if (!convertedFrom || convertedFrom === 'webhook') return 'Pagou sozinho'
    const num = convertedFrom.replace('msg_', '')
    return `Recuperado (msg ${num})`
  }
  if (status === 'completed') {
    return isRecovery ? 'Sem conversão' : 'Confirmada'
  }
  if (status === 'in_progress') return 'Em recuperação'
  if (status === 'failed') return 'Falhou'
  return 'Aguardando'
}

function getStatusDot(status: string | null, convertedFrom: string | null): string {
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
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [eventType, setEventType] = useState('all')
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [addLeadModalOpen, setAddLeadModalOpen] = useState(false)
  const [importModalOpen, setImportModalOpen] = useState(false)
  const searchParams = useSearchParams()
  const { from, to } = resolvePeriod({
    from: searchParams.get('from') ?? undefined,
    to: searchParams.get('to') ?? undefined,
  })

  const fetchLeads = useCallback(async (pg: number) => {
    setLoading(true)
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE + 1),
      offset: String(pg * PAGE_SIZE),
      from,
      to,
    })
    if (eventType !== 'all') params.set('event_type', eventType)
    if (status !== 'all') params.set('status', status)
    const data = await fetch(`/api/leads?${params}`).then(r => r.json())
    const rows: Lead[] = Array.isArray(data) ? data : []
    setHasMore(rows.length > PAGE_SIZE)
    setLeads(rows.slice(0, PAGE_SIZE))
    setLoading(false)
  }, [eventType, status, from, to])

  useEffect(() => {
    setPage(0)
    fetchLeads(0)
  }, [fetchLeads])

  function handlePage(dir: number) {
    const next = page + dir
    setPage(next)
    fetchLeads(next)
  }

  function exportCSV() {
    if (filtered.length === 0) {
      alert('Nenhum lead para exportar.')
      return
    }
    const headers = ['Nome', 'Telefone', 'Email', 'Produto', 'Valor (R$)', 'Evento', 'Status', 'Origem', 'Data']
    const rows = filtered.map(l => [
      `"${(l.name || '').replace(/"/g, '""')}"`,
      `"${l.phone}"`,
      `"${(l.email || '').replace(/"/g, '""')}"`,
      `"${(l.productName || '').replace(/"/g, '""')}"`,
      `"${l.productValue ? (l.productValue / 100).toFixed(2) : '0.00'}"`,
      `"${l.eventType}"`,
      `"${l.status || ''}"`,
      `"${(l as any).trackingSource || l.platform || 'organico'}"`,
      `"${l.createdAt || ''}"`
    ])
    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
    const encodedUri = encodeURI(csvContent)
    const link = document.createElement('a')
    link.setAttribute('href', encodedUri)
    link.setAttribute('download', `leads_export_${new Date().toISOString().split('T')[0]}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  function clearFilters() {
    setEventType('all')
    setStatus('all')
    setSearch('')
  }

  const filtered = search.trim()
    ? leads.filter(l =>
        l.phone.includes(search) ||
        (l.name ?? '').toLowerCase().includes(search.toLowerCase()) ||
        (l.email ?? '').toLowerCase().includes(search.toLowerCase()) ||
        (l.productName ?? '').toLowerCase().includes(search.toLowerCase())
      )
    : leads

  const hasFilters = eventType !== 'all' || status !== 'all' || search.trim().length > 0

  const subtitle = loading
    ? 'Carregando a lista de leads'
    : `Exibindo ${filtered.length} ${filtered.length === 1 ? 'lead' : 'leads'}${
        search.trim() ? ' para a busca atual' : ` na página ${page + 1}`
      }`

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-h1 text-fg">Leads</h1>
          <p className="text-body text-fg-muted mt-1">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            onClick={() => setAddLeadModalOpen(true)}
            className="shrink-0 gap-1.5 bg-brand-solid hover:bg-brand-solid/90 text-on-accent font-bold text-micro shadow-sm"
          >
            <UserPlus size={15} />
            + Adicionar Lead
          </Button>
          <Button
            onClick={() => setImportModalOpen(true)}
            className="shrink-0 gap-1.5 bg-cyan-500 hover:bg-cyan-400 text-black font-bold text-micro"
          >
            <UploadCloud size={15} />
            Importar Planilha / Mineração
          </Button>
          <Button
            variant="outline"
            onClick={exportCSV}
            className="shrink-0 gap-1.5 text-micro border-line-subtle text-fg hover:bg-surface-raised"
          >
            <Download size={14} />
            Exportar CSV
          </Button>
          <PeriodBar from={from} to={to} />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fetchLeads(page)}
            className="shrink-0 gap-2 text-fg-muted hover:text-fg"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Atualizar
          </Button>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:gap-3">
        <div className="relative w-full lg:flex-1 lg:w-auto lg:min-w-[220px]">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar por nome, telefone, email ou produto..."
            aria-label="Buscar leads"
            className={`${FIELD_SKIN} ${CONTROL_HEIGHT} pl-9 text-base lg:text-sm`}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              aria-label="Limpar busca"
              className="focus-ring absolute right-0 top-1/2 -translate-y-1/2 flex min-h-11 min-w-11 items-center justify-center text-fg-subtle hover:text-fg lg:right-3 lg:min-h-0 lg:min-w-0"
            >
              <X size={13} />
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 sm:flex sm:gap-3">
          <Select value={eventType} onValueChange={v => v && setEventType(v)} items={EVENT_TYPE_OPTIONS}>
            <SelectTrigger aria-label="Filtrar por tipo de evento" className={`${FIELD_SKIN} ${SELECT_HEIGHT} min-w-0 text-base sm:w-44 lg:text-sm`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-surface-overlay border-line-subtle">
              {Object.entries(EVENT_TYPE_OPTIONS).map(([val, label]) => (
                <SelectItem key={val} value={val}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={status} onValueChange={v => v && setStatus(v)} items={STATUS_OPTIONS}>
            <SelectTrigger aria-label="Filtrar por status" className={`${FIELD_SKIN} ${SELECT_HEIGHT} min-w-0 text-base sm:w-40 lg:text-sm`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-surface-overlay border-line-subtle">
              {Object.entries(STATUS_OPTIONS).map(([val, label]) => (
                <SelectItem key={val} value={val}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Lista Mobile */}
      <div className="space-y-2 lg:hidden">
        {loading ? (
          <div className="panel flex items-center justify-center p-8 text-fg-muted">
            <RefreshCw size={16} className="animate-spin mr-2" /> Carregando...
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState hasFilters={hasFilters} onClear={clearFilters} />
        ) : (
          filtered.map(lead => {
            const dot = getStatusDot(lead.status, lead.convertedFrom)
            const label = getStatusLabel(lead.status, lead.eventType, lead.convertedFrom)
            const evColor = eventDot[lead.eventType] ?? 'text-fg-faint'
            const evLabel = eventLabels[lead.eventType] ?? lead.eventType
            return (
              <MobileRowCard
                key={lead.id}
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
                <th className="px-4 py-3 text-label uppercase text-fg-subtle font-semibold w-12" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={COLUMNS.length + 1} className="text-center py-12 text-fg-muted">
                    <RefreshCw size={16} className="inline animate-spin mr-2" /> Carregando leads...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length + 1} className="py-6">
                    <EmptyState hasFilters={hasFilters} onClear={clearFilters} />
                  </td>
                </tr>
              ) : (
                filtered.map(lead => {
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
                      <td className="px-4 py-3 max-w-[280px]">
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
                      <td className="px-4 py-3 text-fg-subtle max-w-[240px] truncate">
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
                      <td />
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
            {filtered.length} lead{filtered.length !== 1 ? 's' : ''} {search ? 'encontrado(s)' : `na página ${page + 1}`}
          </span>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={page === 0}
              onClick={() => handlePage(-1)}
              className="min-h-11 lg:min-h-0 px-4 lg:px-3 text-fg-muted hover:text-fg"
            >
              Anterior
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!hasMore}
              onClick={() => handlePage(1)}
              className="min-h-11 lg:min-h-0 px-4 lg:px-3 text-fg-muted hover:text-fg"
            >
              Próxima
            </Button>
          </div>
        </div>
      </div>

      {/* Modais de Cadastro 1x1 e Importação em Massa */}
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
        <p className="text-h2 text-fg">Nenhum lead por aqui</p>
        <p className="text-body text-fg-muted max-w-[46ch]">
          {hasFilters
            ? 'Nenhum lead corresponde aos filtros aplicados. Ajuste a busca ou limpe os filtros para ver a lista completa.'
            : 'Assim que uma plataforma enviar o primeiro webhook ou você cadastrar manualmente, os leads aparecem nesta lista.'}
        </p>
      </div>
      {hasFilters && (
        <Button variant="outline" size="sm" onClick={onClear} className="mt-1 min-h-9 text-fg-muted hover:text-fg">
          Limpar filtros
        </Button>
      )}
    </div>
  )
}
