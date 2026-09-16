'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import {
  MessageSquare,
  Mail,
  Calendar,
  Sparkles,
  Filter,
  Plus,
  Pencil,
  Trash2,
  Megaphone,
  Clock,
  CheckCircle2,
  X,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Check,
  Globe,
  Share2,
  DollarSign,
  User,
  Phone,
  Tag,
  ShoppingBag,
  ExternalLink,
} from 'lucide-react'
import { cn } from '@/lib/utils'

function InstagramIcon({ size = 13, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5"/>
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5"/>
    </svg>
  )
}

export interface KanbanLead {
  id: number
  name: string | null
  phone: string
  email?: string | null
  productName?: string | null
  productValue?: number | null
  eventType: string
  platform?: string | null
  status?: string | null
  stage: string
  channel?: 'whatsapp' | 'instagram' | 'email'
  trackingSource?: string | null
  utmCampaign?: string | null
  utmContent?: string | null
  followUpDate?: string | null
  followUpNote?: string | null
  responsibleAgent?: string | null
  lastActionBy?: string | null
  lastActionAt?: string | Date | null
  updatedAt?: string | Date | null
}

export interface KanbanStage {
  id: string
  label: string
  color: string
}

const DEFAULT_STAGES: KanbanStage[] = [
  { id: 'novo_contato', label: 'Novo Contato', color: '#3987e5' },
  { id: 'em_atendimento', label: 'Em Atendimento', color: '#d95926' },
  { id: 'qualificado', label: 'Qualificado', color: '#199e70' },
  { id: 'agendado', label: 'Agendado / Reserva', color: '#9085e9' },
  { id: 'fechado', label: 'Fechado / Ganho', color: '#008300' },
]

function formatBRL(cents: number | null | undefined): string {
  if (!cents) return 'R$ 0,00'
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function getChannelIcon(channel?: string) {
  switch (channel) {
    case 'instagram':
      return <InstagramIcon size={13} className="text-pink-400" />
    case 'email':
      return <Mail size={13} className="text-blue-400" />
    default:
      return <MessageSquare size={13} className="text-emerald-400" />
  }
}

function getLeadOriginBadge(lead: KanbanLead) {
  const badges: React.ReactNode[] = []
  const seenKeys = new Set<string>()

  const src = (lead.trackingSource || '').toLowerCase()
  const plat = (lead.platform || '').toLowerCase()
  const ev = (lead.eventType || '').toLowerCase()
  const ch = (lead.channel || '').toLowerCase()

  // 1. Mineração (AutonomIA)
  if (src.includes('miner') || ev.includes('prospeccao') || src.includes('prospeccao')) {
    seenKeys.add('mineracao')
    badges.push(
      <span key="min" className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30">
        <span>⛏️</span>
        <span>Mineração</span>
      </span>
    )
  }

  // 2. Meta Ads / Tráfego Pago
  if ((src.includes('meta') || src.includes('facebook') || src.includes('ads') || lead.utmCampaign) && !seenKeys.has('meta')) {
    seenKeys.add('meta')
    const label = lead.utmCampaign ? lead.utmCampaign.slice(0, 18) : (lead.trackingSource || 'Meta Ads')
    badges.push(
      <span
        key="meta"
        title={lead.utmCampaign || lead.trackingSource || 'Meta Ads'}
        className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/30"
      >
        <Megaphone size={11} className="text-blue-400" />
        <span className="truncate max-w-[130px]">{label}</span>
      </span>
    )
  }

  // 3. Google Ads
  if (src.includes('google') && !seenKeys.has('google')) {
    seenKeys.add('google')
    badges.push(
      <span key="google" className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30">
        <Globe size={11} className="text-red-400" />
        <span>Google Ads</span>
      </span>
    )
  }

  // 4. Plataformas de Checkout (Hotmart / Kiwify / Greenn / Zouti)
  if (plat.includes('hotmart') && !seenKeys.has('hotmart')) {
    seenKeys.add('hotmart')
    badges.push(<span key="hot" className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-400 border border-orange-500/20">Hotmart</span>)
  }
  if (plat.includes('kiwify') && !seenKeys.has('kiwify')) {
    seenKeys.add('kiwify')
    badges.push(<span key="kiw" className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">Kiwify</span>)
  }
  if (plat.includes('greenn') && !seenKeys.has('greenn')) {
    seenKeys.add('greenn')
    badges.push(<span key="grn" className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">Greenn</span>)
  }
  if (plat.includes('zouti') && !seenKeys.has('zouti')) {
    seenKeys.add('zouti')
    badges.push(<span key="zou" className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/20">Zouti</span>)
  }

  // 5. Instagram Direct
  if ((ch === 'instagram' || src.includes('instagram')) && !seenKeys.has('instagram')) {
    seenKeys.add('instagram')
    badges.push(
      <span key="ig" className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-pink-500/15 text-pink-400 border border-pink-500/30">
        Instagram DM
      </span>
    )
  }

  // 6. WhatsApp Reserva / Presencial
  if (src.includes('reserva') && !seenKeys.has('reserva')) {
    seenKeys.add('reserva')
    badges.push(<span key="res" className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-400 border border-purple-500/30">Reserva</span>)
  }

  // Se não teve nenhuma identificada, usa trackingSource ou Direto
  if (badges.length === 0) {
    const defaultLabel = lead.trackingSource || 'Direto'
    badges.push(
      <span key="def" className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-surface-inset text-fg-subtle border border-line-subtle truncate max-w-[120px]">
        {defaultLabel}
      </span>
    )
  }

  return <div className="flex flex-wrap items-center gap-1">{badges}</div>
}

export function KanbanBoard({
  initialLeads = [],
  companySlug = 'default',
}: {
  initialLeads: KanbanLead[]
  companySlug?: string
}) {
  const [mounted, setMounted] = useState(false)
  const [leads, setLeads] = useState<KanbanLead[]>(initialLeads)
  const [stages, setStages] = useState<KanbanStage[]>(DEFAULT_STAGES)

  // Carregar etapas da API ou localStorage
  useEffect(() => {
    setMounted(true)
    async function loadStages() {
      try {
        const res = await fetch('/api/pipeline/columns')
        if (res.ok) {
          const data = await res.json()
          if (Array.isArray(data.columns) && data.columns.length > 0) {
            setStages(data.columns)
            return
          }
        }
      } catch {}

      try {
        const saved = localStorage.getItem(`mvp_sac_pipeline_stages_${companySlug}`)
        if (saved) {
          const parsed = JSON.parse(saved)
          if (Array.isArray(parsed) && parsed.length > 0) {
            setStages(parsed)
          }
        }
      } catch {}
    }
    loadStages()
  }, [companySlug])

  useEffect(() => {
    setLeads(initialLeads)
  }, [initialLeads])

  const [filterChannel, setFilterChannel] = useState<string>('all')
  const [filterOrigin, setFilterOrigin] = useState<string>('all')
  const [filterAgent, setFilterAgent] = useState<string>('all')
  const [draggedId, setDraggedId] = useState<number | null>(null)
  const [selectedLead, setSelectedLead] = useState<KanbanLead | null>(null)

  // Estados 100% editáveis do modal do lead
  const [modalName, setModalName] = useState<string>('')
  const [modalPhone, setModalPhone] = useState<string>('')
  const [modalEmail, setModalEmail] = useState<string>('')
  const [modalProductName, setModalProductName] = useState<string>('')
  const [modalProductValue, setModalProductValue] = useState<string>('')
  const [modalTrackingSource, setModalTrackingSource] = useState<string>('Meta Ads')
  const [modalStage, setModalStage] = useState<string>('novo_contato')
  const [modalFollowUpDate, setModalFollowUpDate] = useState<string>('')
  const [modalFollowUpNote, setModalFollowUpNote] = useState<string>('')
  const [modalResponsibleAgent, setModalResponsibleAgent] = useState<string>('')
  const [isSaving, setIsSaving] = useState(false)
  const [savedToast, setSavedToast] = useState<string | null>(null)

  // Estados de Edição Inline de Coluna
  const [inlineEditingStageId, setInlineEditingStageId] = useState<string | null>(null)
  const [inlineEditingLabel, setInlineEditingLabel] = useState('')

  // Estados do modal de criação de nova etapa
  const [showAddStageModal, setShowAddStageModal] = useState(false)
  const [newStageLabel, setNewStageLabel] = useState('')
  const [newStageColor, setNewStageColor] = useState('#3987e5')

  // Estados do modal de edição de etapa existente
  const [editingStage, setEditingStage] = useState<KanbanStage | null>(null)
  const [editStageLabel, setEditStageLabel] = useState('')
  const [editStageColor, setEditStageColor] = useState('#3987e5')

  // Salvar etapas no banco e localStorage
  const persistStages = useCallback(async (newStages: KanbanStage[]) => {
    setStages(newStages)
    try {
      localStorage.setItem(`mvp_sac_pipeline_stages_${companySlug}`, JSON.stringify(newStages))
    } catch {}

    try {
      await fetch('/api/pipeline/columns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columns: newStages }),
      })
    } catch (err) {
      console.error('Erro ao persistir colunas na API:', err)
    }
  }, [companySlug])

  function handleCreateStage(e: React.FormEvent) {
    e.preventDefault()
    if (!newStageLabel.trim()) return
    const id = newStageLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + Date.now().toString().slice(-4)
    const newStages = [...stages, { id, label: newStageLabel.trim(), color: newStageColor }]
    persistStages(newStages)
    setNewStageLabel('')
    setShowAddStageModal(false)
    setSavedToast(`Nova etapa "${newStageLabel}" criada!`)
    setTimeout(() => setSavedToast(null), 3000)
  }

  function startInlineEdit(stage: KanbanStage) {
    setInlineEditingStageId(stage.id)
    setInlineEditingLabel(stage.label)
  }

  function saveInlineEdit(stageId: string) {
    if (!inlineEditingLabel.trim()) {
      setInlineEditingStageId(null)
      return
    }
    const newStages = stages.map(s => s.id === stageId ? { ...s, label: inlineEditingLabel.trim() } : s)
    persistStages(newStages)
    setInlineEditingStageId(null)
    setSavedToast(`Coluna renomeada para "${inlineEditingLabel.trim()}"`)
    setTimeout(() => setSavedToast(null), 3000)
  }

  function openEditStage(stage: KanbanStage) {
    setEditingStage(stage)
    setEditStageLabel(stage.label)
    setEditStageColor(stage.color)
  }

  function handleSaveEditStage(e: React.FormEvent) {
    e.preventDefault()
    if (!editingStage || !editStageLabel.trim()) return

    const newStages = stages.map(s =>
      s.id === editingStage.id
        ? { ...s, label: editStageLabel.trim(), color: editStageColor }
        : s
    )
    persistStages(newStages)
    const oldName = editingStage.label
    setEditingStage(null)
    setSavedToast(`Etapa "${oldName}" atualizada com sucesso!`)
    setTimeout(() => setSavedToast(null), 3000)
  }

  function moveColumn(index: number, direction: 'left' | 'right') {
    const targetIndex = direction === 'left' ? index - 1 : index + 1
    if (targetIndex < 0 || targetIndex >= stages.length) return

    const newStages = [...stages]
    const [moved] = newStages.splice(index, 1)
    newStages.splice(targetIndex, 0, moved)
    persistStages(newStages)
  }

  function handleDeleteStage(stageId: string) {
    if (stages.length <= 1) {
      alert('Você precisa ter pelo menos uma etapa no pipeline.')
      return
    }
    const stageToDelete = stages.find(s => s.id === stageId)
    if (!confirm(`Tem certeza que deseja excluir a etapa "${stageToDelete?.label || stageId}"? Os leads nela serão movidos para a primeira coluna.`)) {
      return
    }

    const fallbackStageId = stages.find(s => s.id !== stageId)?.id || 'novo_contato'

    // Move leads da etapa excluída para a primeira disponível
    setLeads(prev =>
      prev.map(l => (l.stage === stageId ? { ...l, stage: fallbackStageId } : l))
    )

    const newStages = stages.filter(s => s.id !== stageId)
    persistStages(newStages)
    setSavedToast(`Etapa excluída. Leads movidos para a coluna inicial.`)
    setTimeout(() => setSavedToast(null), 3000)
  }

  // Atalhos de Data de Retorno
  const setFollowUpShortcut = (days: number) => {
    const d = new Date()
    d.setDate(d.getDate() + days)
    setModalFollowUpDate(d.toISOString().slice(0, 10))
  }

  // Filtragem dos leads
  const filteredLeads = useMemo(() => {
    return leads.filter((lead) => {
      // Filtro de canal
      if (filterChannel !== 'all' && lead.channel !== filterChannel) return false

      // Filtro de origem
      if (filterOrigin !== 'all') {
        const src = (lead.trackingSource || '').toLowerCase()
        const plat = (lead.platform || '').toLowerCase()

        if (filterOrigin === 'meta' && !src.includes('meta') && !src.includes('facebook') && !lead.utmCampaign) return false
        if (filterOrigin === 'google' && !src.includes('google')) return false
        if (filterOrigin === 'checkout' && !plat.includes('hotmart') && !plat.includes('kiwify') && !plat.includes('greenn') && !plat.includes('zouti')) return false
      }

      // Filtro de Agente IA
      if (filterAgent !== 'all') {
        const agent = (lead.responsibleAgent || '').toLowerCase()
        if (filterAgent === 'bia' && agent !== 'bia') return false
        if (filterAgent === 'luana' && agent !== 'luana') return false
        if (filterAgent === 'unassigned' && agent !== '') return false
      }

      return true
    })
  }, [leads, filterChannel, filterOrigin, filterAgent])

  const handleDragStart = (id: number) => {
    setDraggedId(id)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const handleDrop = async (newStage: string) => {
    if (draggedId === null) return

    setLeads((prev) =>
      prev.map((l) => (l.id === draggedId ? { ...l, stage: newStage } : l))
    )

    try {
      await fetch(`/api/pipeline/${draggedId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: newStage }),
      })
    } catch (err) {
      console.error('Erro ao mover lead:', err)
    } finally {
      setDraggedId(null)
    }
  }

  const openEditModal = (lead: KanbanLead) => {
    setSelectedLead(lead)
    setModalName(lead.name || '')
    setModalPhone(lead.phone || '')
    setModalEmail(lead.email || '')
    setModalProductName(lead.productName || '')
    setModalProductValue(lead.productValue ? (lead.productValue / 100).toFixed(2).replace('.', ',') : '')
    setModalTrackingSource(lead.trackingSource || 'Meta Ads')
    setModalStage(lead.stage || 'novo_contato')
    setModalResponsibleAgent(lead.responsibleAgent || '')
    if (lead.followUpDate) {
      try {
        const d = new Date(lead.followUpDate)
        setModalFollowUpDate(d.toISOString().slice(0, 10))
      } catch {
        setModalFollowUpDate('')
      }
    } else {
      setModalFollowUpDate('')
    }
    setModalFollowUpNote(lead.followUpNote || '')
  }

  const handleSaveModal = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedLead) return

    setIsSaving(true)
    const valCentavos = modalProductValue
      ? Math.round(parseFloat(modalProductValue.replace(/\./g, '').replace(',', '.')) * 100)
      : null

    const updatedLead: KanbanLead = {
      ...selectedLead,
      name: modalName.trim() || null,
      phone: modalPhone.trim(),
      email: modalEmail.trim() || null,
      productName: modalProductName.trim() || null,
      productValue: isNaN(valCentavos as any) ? null : valCentavos,
      trackingSource: modalTrackingSource.trim() || null,
      stage: modalStage,
      followUpDate: modalFollowUpDate ? new Date(modalFollowUpDate + 'T12:00:00-03:00').toISOString() : null,
      followUpNote: modalFollowUpNote.trim() || null,
      responsibleAgent: modalResponsibleAgent.trim() || null,
    }

    setLeads((prev) => prev.map((l) => (l.id === selectedLead.id ? updatedLead : l)))

    try {
      await fetch(`/api/pipeline/${selectedLead.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: updatedLead.name,
          phone: updatedLead.phone,
          email: updatedLead.email,
          productName: updatedLead.productName,
          productValue: updatedLead.productValue,
          trackingSource: updatedLead.trackingSource,
          stage: updatedLead.stage,
          followUpDate: updatedLead.followUpDate,
          followUpNote: updatedLead.followUpNote,
          responsibleAgent: updatedLead.responsibleAgent,
        }),
      })
    } catch (err) {
      console.error('Erro ao salvar lead:', err)
    } finally {
      setIsSaving(false)
    }

    const name = updatedLead.name || 'Contato'
    setSelectedLead(null)
    setSavedToast(`Card de ${name} atualizado com sucesso!`)
    setTimeout(() => setSavedToast(null), 3000)
  }

  const PRESET_COLORS = ['#3987e5', '#199e70', '#d95926', '#9085e9', '#008300', '#e11d48', '#06b6d4', '#eab308']

  return (
    <div className="flex flex-col h-full w-full gap-3 overflow-hidden">
      {/* Toast Notification */}
      {savedToast && (
        <div className="fixed bottom-6 right-6 z-[10000] bg-surface-panel border border-brand-solid/40 text-brand-ink px-4 py-2.5 rounded-xl shadow-2xl flex items-center gap-2 text-body font-medium animate-in fade-in slide-in-from-bottom-3">
          <Sparkles size={16} />
          {savedToast}
        </div>
      )}

      {/* Barra Superior: Filtros e Botão + Nova Etapa */}
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 bg-surface-raised border border-line-subtle rounded-[var(--r-md)] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-micro font-medium uppercase text-fg-subtle mr-1">
            <Filter size={13} />
            Filtros:
          </span>

          {/* Filtro de Origem */}
          <div className="flex items-center gap-1 bg-surface-base border border-line-subtle rounded-[var(--r-sm)] p-1 text-micro">
            <select
              value={filterOrigin}
              onChange={(e) => setFilterOrigin(e.target.value)}
              className="bg-transparent text-fg text-micro font-medium focus:outline-none cursor-pointer px-1"
            >
              <option value="all" className="bg-surface-raised text-fg">Todas as Origens</option>
              <option value="meta" className="bg-surface-raised text-fg">Meta Ads</option>
              <option value="google" className="bg-surface-raised text-fg">Google Ads</option>
              <option value="checkout" className="bg-surface-raised text-fg">Checkouts (Hotmart/Kiwify)</option>
            </select>
          </div>

          {/* Filtro de Canais */}
          <div className="flex items-center gap-1 bg-surface-base border border-line-subtle rounded-[var(--r-sm)] p-1 text-micro">
            <select
              value={filterChannel}
              onChange={(e) => setFilterChannel(e.target.value)}
              className="bg-transparent text-fg text-micro font-medium focus:outline-none cursor-pointer px-1"
            >
              <option value="all" className="bg-surface-raised text-fg">Todos os Canais</option>
              <option value="whatsapp" className="bg-surface-raised text-fg">WhatsApp</option>
              <option value="instagram" className="bg-surface-raised text-fg">Instagram DM</option>
              <option value="email" className="bg-surface-raised text-fg">E-mail</option>
            </select>
          </div>

          {/* Filtro por Agente IA */}
          <div className="flex items-center gap-1 bg-surface-base border border-line-subtle rounded-[var(--r-sm)] p-1 text-micro">
            <select
              value={filterAgent}
              onChange={(e) => setFilterAgent(e.target.value)}
              className="bg-transparent text-fg text-micro font-medium focus:outline-none cursor-pointer px-1"
            >
              <option value="all" className="bg-surface-raised text-fg">Todos os Agentes</option>
              <option value="bia" className="bg-surface-raised text-fg">✨ Bia (Amanda)</option>
              <option value="luana" className="bg-surface-raised text-fg">✨ Luana (Gastão)</option>
              <option value="unassigned" className="bg-surface-raised text-fg">Sem Agente Vinculado</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAddStageModal(true)}
            className="inline-flex items-center gap-1.5 text-micro font-bold bg-brand-glow text-brand-ink hover:bg-brand-solid hover:text-black border border-brand-solid/30 px-3 py-1.5 rounded-lg transition-all cursor-pointer shadow-sm"
          >
            <Plus size={14} />
            Nova Etapa do Funil
          </button>
        </div>
      </div>

      {/* Quadro de Colunas Kanban com Altura Total e Rolagem Suave */}
      <div className="flex-1 min-h-0 flex gap-3 overflow-x-auto pb-2 scroll-thin items-stretch">
        {stages.map((stage, index) => {
          const stageLeads = filteredLeads.filter((l) => l.stage === stage.id)
          const stageTotalValue = stageLeads.reduce((acc, curr) => acc + (curr.productValue || 0), 0)
          const isInlineEditing = inlineEditingStageId === stage.id

          return (
            <div
              key={stage.id}
              onDragOver={handleDragOver}
              onDrop={() => handleDrop(stage.id)}
              className="flex flex-col rounded-[var(--r-md)] bg-surface-base border border-line-subtle min-w-[280px] max-w-[320px] shrink-0 h-full overflow-hidden shadow-xs"
            >
              {/* Topo da Coluna com Controles de Reordenação e Edição */}
              <div
                className="p-3 border-b border-line-subtle flex items-center justify-between shrink-0 bg-surface-raised/40"
                style={{ borderTop: `3px solid ${stage.color}` }}
              >
                <div className="min-w-0 pr-1 flex-1">
                  {isInlineEditing ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        value={inlineEditingLabel}
                        onChange={(e) => setInlineEditingLabel(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveInlineEdit(stage.id)
                          if (e.key === 'Escape') setInlineEditingStageId(null)
                        }}
                        autoFocus
                        className="w-full bg-surface-panel border border-brand-solid text-fg px-2 py-0.5 rounded text-body font-bold outline-none"
                      />
                      <button
                        onClick={() => saveInlineEdit(stage.id)}
                        className="p-1 text-emerald-400 hover:bg-emerald-500/20 rounded"
                      >
                        <Check size={14} />
                      </button>
                      <button
                        onClick={() => setInlineEditingStageId(null)}
                        className="p-1 text-rose-400 hover:bg-rose-500/20 rounded"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <>
                      <h3
                        onDoubleClick={() => startInlineEdit(stage)}
                        onClick={() => openEditStage(stage)}
                        title="Clique duplo para renomear ou clique para editar cor"
                        className="text-body font-bold text-fg truncate cursor-pointer hover:text-brand-ink transition-colors flex items-center gap-1"
                      >
                        <span>{stage.label}</span>
                        <Pencil size={11} className="opacity-0 hover:opacity-100 text-fg-faint" />
                      </h3>
                      <p className="text-micro font-medium text-brand-ink">
                        {formatBRL(stageTotalValue)}
                      </p>
                    </>
                  )}
                </div>

                <div className="flex items-center gap-0.5 shrink-0">
                  <span className="num flex h-6 w-6 items-center justify-center rounded-full bg-surface-raised border border-line-subtle text-micro font-bold text-fg mr-1">
                    {stageLeads.length}
                  </span>

                  {/* Mover Coluna para Esquerda */}
                  {index > 0 && (
                    <button
                      type="button"
                      onClick={() => moveColumn(index, 'left')}
                      title="Mover coluna para a esquerda"
                      className="p-1 text-fg-faint hover:text-fg hover:bg-surface-inset rounded transition-colors cursor-pointer"
                    >
                      <ChevronLeft size={13} />
                    </button>
                  )}

                  {/* Mover Coluna para Direita */}
                  {index < stages.length - 1 && (
                    <button
                      type="button"
                      onClick={() => moveColumn(index, 'right')}
                      title="Mover coluna para a direita"
                      className="p-1 text-fg-faint hover:text-fg hover:bg-surface-inset rounded transition-colors cursor-pointer"
                    >
                      <ChevronRight size={13} />
                    </button>
                  )}

                  {/* Editar Nome e Cor da Coluna */}
                  <button
                    type="button"
                    onClick={() => openEditStage(stage)}
                    title="Editar coluna"
                    className="p-1 text-fg-faint hover:text-brand-ink hover:bg-surface-inset rounded transition-colors cursor-pointer"
                  >
                    <Pencil size={12} />
                  </button>

                  {/* Excluir Coluna */}
                  <button
                    type="button"
                    onClick={() => handleDeleteStage(stage.id)}
                    title="Excluir coluna"
                    className="p-1 text-fg-faint hover:text-red-400 hover:bg-surface-inset rounded transition-colors cursor-pointer"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>

              {/* Lista de Cards da Coluna com rolagem independente */}
              <div className="flex-1 p-2 space-y-2 overflow-y-auto scroll-thin">
                {stageLeads.length === 0 ? (
                  <div className="flex items-center justify-center h-28 border border-dashed border-line-subtle rounded-[var(--r-sm)] text-micro text-fg-faint select-none">
                    Arraste leads para cá
                  </div>
                ) : (
                  stageLeads.map((lead) => (
                    <div
                      key={lead.id}
                      draggable
                      onDragStart={() => handleDragStart(lead.id)}
                      onClick={() => openEditModal(lead)}
                      className="card bg-surface-raised border border-line-subtle p-3 rounded-[var(--r-sm)] shadow-xs hover:border-brand-ink/60 hover:-translate-y-0.5 transition-all cursor-pointer space-y-2 group select-none"
                    >
                      {/* Selos de Origem, Canal e Agente */}
                      <div className="flex items-center justify-between gap-1 flex-wrap">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {getLeadOriginBadge(lead)}
                          {lead.responsibleAgent && (
                            <span
                              title={`Agente: ${lead.responsibleAgent} (${lead.responsibleAgent === 'Bia' ? 'Amanda' : lead.responsibleAgent === 'Luana' ? 'Gastão' : 'Operação'})`}
                              className={cn(
                                "inline-flex items-center gap-1 text-[10px] font-black px-2 py-0.5 rounded-full border shadow-2xs",
                                lead.responsibleAgent === 'Bia'
                                  ? "bg-rose-500/15 text-rose-400 border-rose-500/30"
                                  : lead.responsibleAgent === 'Luana'
                                  ? "bg-purple-500/15 text-purple-400 border-purple-500/30"
                                  : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                              )}
                            >
                              <Sparkles size={10} className={lead.responsibleAgent === 'Bia' ? "text-rose-400" : "text-purple-400"} />
                              {lead.responsibleAgent} {lead.responsibleAgent === 'Bia' ? '(Amanda)' : lead.responsibleAgent === 'Luana' ? '(Gastão)' : ''}
                            </span>
                          )}
                        </div>
                        <span className="flex items-center gap-1 text-[11px] text-fg-subtle shrink-0">
                          {getChannelIcon(lead.channel)}
                          <span className="capitalize">{lead.channel || 'WhatsApp'}</span>
                        </span>
                      </div>

                      {/* Dados do Contato */}
                      <div>
                        <h4 className="text-body font-semibold text-fg truncate group-hover:text-brand-ink transition-colors">
                          {lead.name || 'Contato sem nome'}
                        </h4>
                        <div className="flex items-center justify-between gap-2 text-micro text-fg-subtle">
                          <span className="truncate">{lead.productName || 'Interesse Comercial'}</span>
                          {lead.lastActionBy && (
                            <span title={lead.lastActionBy} className="text-[10px] text-fg-faint truncate shrink-0 max-w-[120px]">
                              {lead.lastActionBy}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Follow-up / Lembrete (se configurado) */}
                      {lead.followUpDate && (() => {
                        const today = new Date()
                        today.setHours(0, 0, 0, 0)
                        const fDate = new Date(lead.followUpDate)
                        const isOverdue = fDate.getTime() < today.getTime()
                        const isToday = fDate.toDateString() === today.toDateString()
                        const formatted = fDate.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })

                        return (
                          <div
                            title={lead.followUpNote ? `Retorno: ${lead.followUpNote}` : 'Retorno agendado'}
                            className={cn(
                              "px-2 py-1 text-[10px] font-bold rounded-md border flex items-center gap-1.5 transition-all",
                              isOverdue && "bg-red-500/10 text-red-400 border-red-500/30",
                              isToday && "bg-amber-500/10 text-amber-400 border-amber-500/30",
                              !isOverdue && !isToday && "bg-blue-500/10 text-blue-400 border-blue-500/30"
                            )}
                          >
                            <span className={cn(
                              "h-1.5 w-1.5 rounded-full shrink-0",
                              isOverdue && "bg-red-500 animate-pulse",
                              isToday && "bg-amber-500 animate-pulse",
                              !isOverdue && !isToday && "bg-blue-400"
                            )} />
                            <Clock size={11} className="shrink-0" />
                            <span className="truncate">
                              {isOverdue ? `Atrasado: ${formatted}` : isToday ? 'Hoje' : formatted}
                              {lead.followUpNote && ` · ${lead.followUpNote}`}
                            </span>
                          </div>
                        )
                      })()}

                      {/* Valor e Ações Rápidas */}
                      <div className="flex items-center justify-between text-micro pt-1 border-t border-line-subtle">
                        <span className="num font-bold text-brand-ink flex items-center">
                          {formatBRL(lead.productValue)}
                        </span>

                        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                          {lead.phone && (
                            <a
                              href={`https://wa.me/${lead.phone.replace(/\D/g, '')}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-[11px] text-emerald-400 hover:text-emerald-300 font-medium px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20"
                            >
                              <MessageSquare size={11} />
                              Zap
                            </a>
                          )}
                          <button
                            onClick={() => openEditModal(lead)}
                            className="text-[10px] text-brand-ink bg-brand-glow px-2 py-0.5 rounded border border-brand-solid/20 hover:bg-brand-solid hover:text-black font-semibold transition-all cursor-pointer"
                          >
                            Editar
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )
        })}

        {/* Botão para Criar Nova Etapa no Final do Kanban */}
        <div className="min-w-[200px] shrink-0 flex items-start pt-2">
          <button
            onClick={() => setShowAddStageModal(true)}
            className="w-full flex items-center justify-center gap-2 p-4 rounded-xl border border-dashed border-line-subtle hover:border-brand-solid text-fg-subtle hover:text-brand-ink text-body font-semibold transition-all hover:bg-surface-raised/40 cursor-pointer"
          >
            <Plus size={16} />
            <span>Adicionar Coluna</span>
          </button>
        </div>
      </div>

      {/* MODAL DE EDIÇÃO 100% COMPLETO E EDITÁVEL DO LEAD */}
      {mounted &&
        selectedLead &&
        createPortal(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-150">
            <div className="bg-surface-panel border border-line-subtle rounded-2xl w-full max-w-xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
              {/* Topo do Modal */}
              <div className="p-4 sm:p-5 border-b border-line-subtle flex items-center justify-between bg-surface-raised/50">
                <div className="min-w-0 pr-2">
                  <p className="text-[11px] uppercase tracking-wider text-brand-ink font-bold">Editar Lead no Funil</p>
                  <h3 className="text-h3 text-fg font-bold truncate mt-0.5">{selectedLead.name || 'Contato'}</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedLead(null)}
                  className="p-1.5 text-fg-subtle hover:text-fg hover:bg-surface-inset rounded-lg transition-colors cursor-pointer"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Formulário com todos os campos 100% editáveis */}
              <form onSubmit={handleSaveModal} className="p-4 sm:p-5 space-y-4 overflow-y-auto flex-1 scroll-thin">
                {/* Linha 1: Nome e Telefone */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-micro font-bold text-fg mb-1 flex items-center gap-1">
                      <User size={12} className="text-fg-subtle" />
                      Nome do Contato
                    </label>
                    <input
                      type="text"
                      value={modalName}
                      onChange={(e) => setModalName(e.target.value)}
                      placeholder="Nome completo..."
                      className="w-full bg-surface-inset border border-line-subtle rounded-xl px-3 py-2 text-body text-fg focus:outline-none focus:border-brand-solid"
                    />
                  </div>

                  <div>
                    <label className="block text-micro font-bold text-fg mb-1 flex items-center gap-1">
                      <Phone size={12} className="text-fg-subtle" />
                      Telefone / WhatsApp
                    </label>
                    <input
                      type="text"
                      required
                      value={modalPhone}
                      onChange={(e) => setModalPhone(e.target.value)}
                      placeholder="5575999999999"
                      className="w-full bg-surface-inset border border-line-subtle rounded-xl px-3 py-2 text-body text-fg focus:outline-none focus:border-brand-solid font-mono text-[13px]"
                    />
                  </div>
                </div>

                {/* Linha 2: Origem e E-mail */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-micro font-bold text-fg mb-1 flex items-center gap-1">
                      <Megaphone size={12} className="text-fg-subtle" />
                      Origem / Campanha
                    </label>
                    <input
                      type="text"
                      value={modalTrackingSource}
                      onChange={(e) => setModalTrackingSource(e.target.value)}
                      placeholder="Ex: Meta Ads Dr. Lucas, Google, Instagram..."
                      className="w-full bg-surface-inset border border-line-subtle rounded-xl px-3 py-2 text-body text-fg focus:outline-none focus:border-brand-solid"
                    />
                  </div>

                  <div>
                    <label className="block text-micro font-bold text-fg mb-1 flex items-center gap-1">
                      <Mail size={12} className="text-fg-subtle" />
                      E-mail (opcional)
                    </label>
                    <input
                      type="email"
                      value={modalEmail}
                      onChange={(e) => setModalEmail(e.target.value)}
                      placeholder="contato@exemplo.com"
                      className="w-full bg-surface-inset border border-line-subtle rounded-xl px-3 py-2 text-body text-fg focus:outline-none focus:border-brand-solid"
                    />
                  </div>
                </div>

                {/* Linha 3: Valor e Produto/Interesse */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-micro font-bold text-fg mb-1 flex items-center gap-1">
                      <DollarSign size={12} className="text-emerald-400" />
                      Valor Previsto / Fechamento (R$)
                    </label>
                    <input
                      type="text"
                      value={modalProductValue}
                      onChange={(e) => setModalProductValue(e.target.value)}
                      placeholder="Ex: 450,00"
                      className="w-full bg-surface-inset border border-line-subtle rounded-xl px-3 py-2 text-body text-fg focus:outline-none focus:border-brand-solid font-mono font-bold text-emerald-400"
                    />
                  </div>

                  <div>
                    <label className="block text-micro font-bold text-fg mb-1 flex items-center gap-1">
                      <ShoppingBag size={12} className="text-fg-subtle" />
                      Produto / Interesse
                    </label>
                    <input
                      type="text"
                      value={modalProductName}
                      onChange={(e) => setModalProductName(e.target.value)}
                      placeholder="Ex: Consulta Dermatológica..."
                      className="w-full bg-surface-inset border border-line-subtle rounded-xl px-3 py-2 text-body text-fg focus:outline-none focus:border-brand-solid"
                    />
                  </div>
                </div>

                {/* Linha 4: Etapa do Pipeline & Agente IA */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-micro font-bold text-fg mb-1">
                      Etapa do Pipeline
                    </label>
                    <select
                      value={modalStage}
                      onChange={(e) => setModalStage(e.target.value)}
                      className="w-full bg-surface-inset border border-line-subtle rounded-xl px-3 py-2 text-body text-fg focus:outline-none focus:border-brand-solid cursor-pointer"
                    >
                      {stages.map((st) => (
                        <option key={st.id} value={st.id} className="bg-surface-panel text-fg">
                          {st.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-micro font-bold text-fg mb-1">
                      Agente IA Responsável
                    </label>
                    <select
                      value={modalResponsibleAgent}
                      onChange={(e) => setModalResponsibleAgent(e.target.value)}
                      className="w-full bg-surface-inset border border-line-subtle rounded-xl px-3 py-2 text-body text-fg focus:outline-none focus:border-brand-solid cursor-pointer"
                    >
                      <option value="" className="bg-surface-panel text-fg">Sem Agente Vinculado</option>
                      <option value="Bia" className="bg-surface-panel text-fg">✨ Bia (Amanda)</option>
                      <option value="Luana" className="bg-surface-panel text-fg">✨ Luana (Gastão)</option>
                    </select>
                  </div>
                </div>

                {/* Bloco de Follow-up / Lembrete de Retorno com Atalhos */}
                <div className="p-3.5 bg-blue-500/5 border border-blue-500/20 rounded-xl space-y-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <span className="text-micro font-bold text-blue-400 flex items-center gap-1.5 uppercase tracking-wider">
                      <Clock size={13} />
                      Lembrete de Retorno (Follow-up)
                    </span>
                    {modalFollowUpDate && (
                      <button
                        type="button"
                        onClick={() => setModalFollowUpDate('')}
                        className="text-[11px] text-red-400 hover:underline cursor-pointer"
                      >
                        Limpar lembrete
                      </button>
                    )}
                  </div>

                  {/* Atalhos Rápidos */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[11px] text-fg-subtle">Atalhos:</span>
                    <button
                      type="button"
                      onClick={() => setFollowUpShortcut(0)}
                      className="px-2 py-0.5 rounded-lg text-[11px] font-bold bg-surface-raised hover:bg-surface-inset border border-line-subtle text-fg cursor-pointer transition-colors"
                    >
                      Hoje
                    </button>
                    <button
                      type="button"
                      onClick={() => setFollowUpShortcut(1)}
                      className="px-2 py-0.5 rounded-lg text-[11px] font-bold bg-surface-raised hover:bg-surface-inset border border-line-subtle text-fg cursor-pointer transition-colors"
                    >
                      Amanhã
                    </button>
                    <button
                      type="button"
                      onClick={() => setFollowUpShortcut(3)}
                      className="px-2 py-0.5 rounded-lg text-[11px] font-bold bg-surface-raised hover:bg-surface-inset border border-line-subtle text-fg cursor-pointer transition-colors"
                    >
                      Em 3 dias
                    </button>
                    <button
                      type="button"
                      onClick={() => setFollowUpShortcut(7)}
                      className="px-2 py-0.5 rounded-lg text-[11px] font-bold bg-surface-raised hover:bg-surface-inset border border-line-subtle text-fg cursor-pointer transition-colors"
                    >
                      Próxima semana
                    </button>
                    <button
                      type="button"
                      onClick={() => setFollowUpShortcut(15)}
                      className="px-2 py-0.5 rounded-lg text-[11px] font-bold bg-surface-raised hover:bg-surface-inset border border-line-subtle text-fg cursor-pointer transition-colors"
                    >
                      Em 15 dias
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-bold text-fg mb-1">
                        Data agendada:
                      </label>
                      <input
                        type="date"
                        value={modalFollowUpDate}
                        onChange={(e) => setModalFollowUpDate(e.target.value)}
                        className="w-full bg-surface-base border border-line-subtle rounded-xl px-3 py-1.5 text-body text-fg focus:outline-none focus:border-brand-solid"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-bold text-fg mb-1">
                        Motivo do retorno:
                      </label>
                      <input
                        type="text"
                        value={modalFollowUpNote}
                        onChange={(e) => setModalFollowUpNote(e.target.value)}
                        placeholder="Ex: Ligar para confirmar procedimento..."
                        className="w-full bg-surface-base border border-line-subtle rounded-xl px-3 py-1.5 text-body text-fg focus:outline-none focus:border-brand-solid placeholder:text-fg-faint"
                      />
                    </div>
                  </div>
                </div>

                {/* Rodapé com Ações: Abrir WhatsApp, Cancelar, Salvar */}
                <div className="pt-3 border-t border-line-subtle flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    {modalPhone && (
                      <a
                        href={`https://wa.me/${modalPhone.replace(/\D/g, '')}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-[12px] text-emerald-400 hover:text-emerald-300 font-bold px-3 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30 transition-colors"
                      >
                        <MessageSquare size={14} />
                        Abrir WhatsApp
                      </a>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedLead(null)}
                      className="px-4 py-2 rounded-xl text-body font-medium text-fg-subtle hover:bg-surface-inset transition-colors cursor-pointer"
                    >
                      Cancelar
                    </button>
                    <button
                      type="submit"
                      disabled={isSaving}
                      className="px-5 py-2 rounded-xl text-body font-bold bg-emerald-600 hover:bg-emerald-500 text-white transition-all disabled:opacity-50 cursor-pointer shadow-md"
                    >
                      {isSaving ? 'Salvando...' : 'Salvar Alterações'}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>,
          document.body
        )}

      {/* MODAL DE CRIAÇÃO DE NOVA ETAPA */}
      {mounted &&
        showAddStageModal &&
        createPortal(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-150">
            <div className="bg-surface-panel border border-line-subtle rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col">
              <div className="p-5 border-b border-line-subtle flex items-center justify-between">
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-brand-ink font-bold">Personalização do Funil</p>
                  <h3 className="text-h3 text-fg font-bold mt-0.5">Criar Nova Coluna</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAddStageModal(false)}
                  className="p-1.5 text-fg-subtle hover:text-fg hover:bg-surface-inset rounded-lg transition-colors cursor-pointer"
                >
                  <X size={18} />
                </button>
              </div>

              <form onSubmit={handleCreateStage} className="p-5 space-y-4">
                <div>
                  <label className="block text-micro font-bold text-fg mb-1.5">
                    Nome da Nova Coluna / Etapa
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="Ex: Proposta Enviada, Visita Agendada..."
                    value={newStageLabel}
                    onChange={(e) => setNewStageLabel(e.target.value)}
                    className="w-full bg-surface-inset border border-line-subtle rounded-xl px-3 py-2 text-body text-fg focus:outline-none focus:border-brand-solid placeholder:text-fg-faint"
                  />
                </div>

                <div>
                  <label className="block text-micro font-bold text-fg mb-1.5">
                    Cor Indicadora da Coluna
                  </label>
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    {PRESET_COLORS.map((col) => (
                      <button
                        key={col}
                        type="button"
                        onClick={() => setNewStageColor(col)}
                        style={{ backgroundColor: col }}
                        className={cn(
                          "w-7 h-7 rounded-full transition-transform cursor-pointer flex items-center justify-center",
                          newStageColor === col ? "scale-125 ring-2 ring-white" : "hover:scale-110"
                        )}
                      >
                        {newStageColor === col && <CheckCircle2 size={14} className="text-white" />}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="pt-3 border-t border-line-subtle flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowAddStageModal(false)}
                    className="px-4 py-2 rounded-xl text-body font-medium text-fg-subtle hover:bg-surface-inset transition-colors cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 rounded-xl text-body font-bold bg-brand-solid text-on-accent hover:opacity-90 transition-opacity cursor-pointer shadow-sm"
                  >
                    Criar Coluna
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body
        )}

      {/* MODAL DE EDIÇÃO DE ETAPA EXISTENTE */}
      {mounted &&
        editingStage &&
        createPortal(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-150">
            <div className="bg-surface-panel border border-line-subtle rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col">
              <div className="p-5 border-b border-line-subtle flex items-center justify-between">
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-fg-subtle font-bold">Editar Coluna</p>
                  <h3 className="text-h3 text-fg font-bold mt-0.5">{editingStage.label}</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setEditingStage(null)}
                  className="p-1.5 text-fg-subtle hover:text-fg hover:bg-surface-inset rounded-lg transition-colors cursor-pointer"
                >
                  <X size={18} />
                </button>
              </div>

              <form onSubmit={handleSaveEditStage} className="p-5 space-y-4">
                <div>
                  <label className="block text-micro font-bold text-fg mb-1.5">
                    Nome da Etapa
                  </label>
                  <input
                    type="text"
                    required
                    value={editStageLabel}
                    onChange={(e) => setEditStageLabel(e.target.value)}
                    className="w-full bg-surface-inset border border-line-subtle rounded-xl px-3 py-2 text-body text-fg focus:outline-none focus:border-brand-solid"
                  />
                </div>

                <div>
                  <label className="block text-micro font-bold text-fg mb-1.5">
                    Cor Indicadora
                  </label>
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    {PRESET_COLORS.map((col) => (
                      <button
                        key={col}
                        type="button"
                        onClick={() => setEditStageColor(col)}
                        style={{ backgroundColor: col }}
                        className={cn(
                          "w-7 h-7 rounded-full transition-transform cursor-pointer flex items-center justify-center",
                          editStageColor === col ? "scale-125 ring-2 ring-white" : "hover:scale-110"
                        )}
                      >
                        {editStageColor === col && <CheckCircle2 size={14} className="text-white" />}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="pt-3 border-t border-line-subtle flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingStage(null)}
                    className="px-4 py-2 rounded-xl text-body font-medium text-fg-subtle hover:bg-surface-inset transition-colors cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 rounded-xl text-body font-bold bg-brand-solid text-on-accent hover:opacity-90 transition-opacity cursor-pointer shadow-sm"
                  >
                    Salvar Etapa
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
