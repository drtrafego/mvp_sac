'use client'

import { useState, useEffect } from 'react'
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

function MetaAdsIcon({ size = 13, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
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
  const src = (lead.trackingSource || '').toLowerCase()
  const plat = (lead.platform || '').toLowerCase()
  const ev = (lead.eventType || '').toLowerCase()

  // 1. Meta Ads / Tráfego Pago
  if (src.includes('meta') || src.includes('facebook') || lead.utmCampaign) {
    const label = lead.utmCampaign ? lead.utmCampaign.slice(0, 20) : 'Meta Ads'
    return (
      <span
        title={lead.utmCampaign || 'Meta Ads'}
        className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/30"
      >
        <Megaphone size={11} className="text-blue-400" />
        <span className="truncate max-w-[110px]">{label}</span>
      </span>
    )
  }

  // 2. Mineração / Prospecção Ativa
  if (src.includes('mineracao') || ev.includes('prospeccao') || src.includes('prospeccao')) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-400 border border-cyan-500/30">
        <span>⛏️</span>
        <span>Mineração</span>
      </span>
    )
  }

  // 3. Plataformas de Checkout
  if (plat.includes('hotmart')) {
    return <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-400 border border-orange-500/20">Hotmart</span>
  }
  if (plat.includes('kiwify')) {
    return <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Kiwify</span>
  }
  if (plat.includes('greenn')) {
    return <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">Greenn</span>
  }
  if (plat.includes('zouti')) {
    return <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">Zouti</span>
  }

  // 4. Instagram / WhatsApp Direto
  if (lead.channel === 'instagram') {
    return <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-pink-500/15 text-pink-400 border border-pink-500/30">Instagram DM</span>
  }

  return <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-surface-inset text-fg-subtle border border-line-subtle">Direto</span>
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

  // Carregar etapas personalizadas do localStorage por empresa
  useEffect(() => {
    setMounted(true)
    try {
      const saved = localStorage.getItem(`mvp_sac_pipeline_stages_${companySlug}`)
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length > 0) {
          setStages(parsed)
        }
      }
    } catch {
      // Usa DEFAULT_STAGES
    }
  }, [companySlug])

  useEffect(() => {
    setLeads(initialLeads)
  }, [initialLeads])

  const [filterChannel, setFilterChannel] = useState<string>('all')
  const [filterOrigin, setFilterOrigin] = useState<string>('all')
  const [draggedId, setDraggedId] = useState<number | null>(null)
  const [selectedLead, setSelectedLead] = useState<KanbanLead | null>(null)

  // Estados do modal de edição do lead
  const [modalStage, setModalStage] = useState<string>('novo_contato')
  const [modalFollowUpDate, setModalFollowUpDate] = useState<string>('')
  const [modalFollowUpNote, setModalFollowUpNote] = useState<string>('')
  const [modalNotes, setModalNotes] = useState<string>('')
  const [isSaving, setIsSaving] = useState(false)
  const [savedToast, setSavedToast] = useState<string | null>(null)

  // Estados do modal de criação de nova etapa
  const [showAddStageModal, setShowAddStageModal] = useState(false)
  const [newStageLabel, setNewStageLabel] = useState('')
  const [newStageColor, setNewStageColor] = useState('#3987e5')

  // Salvar etapas no localStorage
  function persistStages(newStages: KanbanStage[]) {
    setStages(newStages)
    try {
      localStorage.setItem(`mvp_sac_pipeline_stages_${companySlug}`, JSON.stringify(newStages))
    } catch {
      // Ignora erro de storage
    }
  }

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

  function handleDeleteStage(stageId: string) {
    if (stages.length <= 2) {
      alert('O pipeline precisa de pelo menos 2 etapas.')
      return
    }
    const hasLeads = leads.some(l => l.stage === stageId)
    if (hasLeads) {
      alert('Não é possível excluir uma etapa que ainda possui leads. Mova os leads antes.')
      return
    }
    const filtered = stages.filter(s => s.id !== stageId)
    persistStages(filtered)
  }

  // Filtragem dos cards
  const filteredLeads = leads.filter((item) => {
    if (filterChannel !== 'all' && item.channel !== filterChannel) return false
    if (filterOrigin === 'meta' && !item.trackingSource?.includes('meta') && !item.utmCampaign) return false
    if (filterOrigin === 'mineracao' && !item.trackingSource?.includes('mineracao') && item.eventType !== 'prospeccao') return false
    if (filterOrigin === 'checkout' && !['hotmart', 'kiwify', 'greenn', 'zouti'].includes((item.platform || '').toLowerCase())) return false
    return true
  })

  // Mover lead de etapa (drag & drop)
  async function moveStage(leadId: number, targetStage: string) {
    setLeads((prev) =>
      prev.map((l) => (l.id === leadId ? { ...l, stage: targetStage } : l))
    )

    try {
      await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: targetStage }),
      })
    } catch (err) {
      console.error('Erro ao persistir mudança de etapa:', err)
    }
  }

  function handleDragStart(id: number) {
    setDraggedId(id)
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
  }

  function handleDrop(stageId: string) {
    if (draggedId !== null) {
      moveStage(draggedId, stageId)
      setDraggedId(null)
    }
  }

  function openEditModal(lead: KanbanLead) {
    setSelectedLead(lead)
    setModalStage(lead.stage || 'novo_contato')
    setModalFollowUpDate(lead.followUpDate ? new Date(lead.followUpDate).toISOString().split('T')[0] : '')
    setModalFollowUpNote(lead.followUpNote || '')
    setModalNotes('')
  }

  // Atalhos rápidos de data de follow-up
  function setQuickFollowUp(days: number) {
    const target = new Date()
    target.setDate(target.getDate() + days)
    setModalFollowUpDate(target.toISOString().split('T')[0])
  }

  async function handleSaveModal(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedLead) return

    setIsSaving(true)
    const updatedLead: KanbanLead = {
      ...selectedLead,
      stage: modalStage,
      followUpDate: modalFollowUpDate ? new Date(modalFollowUpDate + 'T12:00:00-03:00').toISOString() : null,
      followUpNote: modalFollowUpNote.trim() || null,
    }

    setLeads((prev) =>
      prev.map((l) => (l.id === selectedLead.id ? updatedLead : l))
    )

    try {
      await fetch(`/api/leads/${selectedLead.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stage: modalStage,
          followUpDate: modalFollowUpDate ? new Date(modalFollowUpDate + 'T12:00:00-03:00').toISOString() : null,
          followUpNote: modalFollowUpNote.trim() || null,
        }),
      })
    } catch (err) {
      console.error('Erro ao salvar lead:', err)
    } finally {
      setIsSaving(false)
    }

    const name = selectedLead.name || 'Contato'
    setSelectedLead(null)
    setSavedToast(`Card de ${name} atualizado com sucesso!`)
    setTimeout(() => setSavedToast(null), 3000)
  }

  const PRESET_COLORS = ['#3987e5', '#199e70', '#d95926', '#9085e9', '#008300', '#e11d48', '#06b6d4', '#eab308']

  return (
    <div className="flex flex-col h-[calc(100vh-170px)] min-h-[500px] w-full gap-3 relative">
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
              <option value="mineracao" className="bg-surface-raised text-fg">Mineração</option>
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
        {stages.map((stage) => {
          const stageLeads = filteredLeads.filter((l) => l.stage === stage.id)
          const stageTotalValue = stageLeads.reduce((acc, curr) => acc + (curr.productValue || 0), 0)

          return (
            <div
              key={stage.id}
              onDragOver={handleDragOver}
              onDrop={() => handleDrop(stage.id)}
              className="flex flex-col rounded-[var(--r-md)] bg-surface-base border border-line-subtle min-w-[280px] max-w-[320px] shrink-0 h-full overflow-hidden"
            >
              {/* Topo da Coluna */}
              <div
                className="p-3 border-b border-line-subtle flex items-center justify-between shrink-0 bg-surface-raised/40"
                style={{ borderTop: `3px solid ${stage.color}` }}
              >
                <div className="min-w-0 pr-2">
                  <h3 className="text-body font-bold text-fg truncate">
                    {stage.label}
                  </h3>
                  <p className="text-micro font-medium text-brand-ink">
                    {formatBRL(stageTotalValue)}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="num flex h-6 w-6 items-center justify-center rounded-full bg-surface-raised border border-line-subtle text-micro font-bold text-fg">
                    {stageLeads.length}
                  </span>
                  {!DEFAULT_STAGES.some(ds => ds.id === stage.id) && stageLeads.length === 0 && (
                    <button
                      onClick={() => handleDeleteStage(stage.id)}
                      title="Excluir etapa vazia"
                      className="p-1 text-fg-faint hover:text-red-400 transition-colors"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
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
                      className="card bg-surface-raised border border-line-subtle p-3 rounded-[var(--r-sm)] shadow-sm hover:border-brand-ink/60 hover:-translate-y-0.5 transition-all cursor-pointer space-y-2 group"
                    >
                      {/* Selos de Origem e Canal */}
                      <div className="flex items-center justify-between gap-1">
                        {getLeadOriginBadge(lead)}
                        <span className="flex items-center gap-1 text-[11px] text-fg-subtle">
                          {getChannelIcon(lead.channel)}
                          <span className="capitalize">{lead.channel || 'WhatsApp'}</span>
                        </span>
                      </div>

                      {/* Dados do Contato */}
                      <div>
                        <h4 className="text-body font-semibold text-fg truncate group-hover:text-brand-ink transition-colors">
                          {lead.name || 'Contato sem nome'}
                        </h4>
                        <p className="text-micro text-fg-subtle truncate">
                          {lead.productName || 'Interesse Comercial'}
                        </p>
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
                            className="text-[10px] text-brand-ink bg-brand-glow px-2 py-0.5 rounded border border-brand-solid/20 hover:bg-brand-solid hover:text-black font-semibold transition-all"
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

      {/* MODAL DE EDIÇÃO DO CARD (COM LEMBRETE FOLLOW-UP) */}
      {mounted &&
        selectedLead &&
        createPortal(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-150">
            <div className="bg-surface-panel border border-line-subtle rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
              <div className="p-5 border-b border-line-subtle flex items-center justify-between">
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-fg-subtle font-bold">Editar Lead no Funil</p>
                  <h3 className="text-h3 text-fg font-bold mt-0.5">{selectedLead.name || 'Contato'}</h3>
                </div>
                <button
                  onClick={() => setSelectedLead(null)}
                  className="text-fg-subtle hover:text-fg text-xl p-1 font-bold cursor-pointer"
                >
                  <X size={18} />
                </button>
              </div>

              <form onSubmit={handleSaveModal} className="p-5 space-y-4 overflow-y-auto">
                <div className="grid grid-cols-2 gap-3 bg-surface-inset p-3 rounded-xl border border-line-subtle text-micro">
                  <div>
                    <span className="text-fg-faint block uppercase">Telefone:</span>
                    <span className="text-fg font-mono font-bold">{selectedLead.phone || '—'}</span>
                  </div>
                  <div>
                    <span className="text-fg-faint block uppercase">Origem / Campanha:</span>
                    <div className="mt-0.5">{getLeadOriginBadge(selectedLead)}</div>
                  </div>
                  <div>
                    <span className="text-fg-faint block uppercase">Valor:</span>
                    <span className="text-brand-ink font-bold">{formatBRL(selectedLead.productValue)}</span>
                  </div>
                  <div>
                    <span className="text-fg-faint block uppercase">Produto / Interesse:</span>
                    <span className="text-fg font-semibold truncate block">{selectedLead.productName || 'Geral'}</span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] uppercase font-bold text-fg-subtle">Etapa do Pipeline</label>
                  <select
                    value={modalStage}
                    onChange={(e) => setModalStage(e.target.value)}
                    className="w-full bg-surface-base border border-line-subtle rounded-xl px-3 py-2.5 text-body text-fg focus:border-brand-ink outline-none"
                  >
                    {stages.map((s) => (
                      <option key={s.id} value={s.id} className="bg-surface-raised">{s.label}</option>
                    ))}
                  </select>
                </div>

                {/* BLOCO DE LEMBRETE / FOLLOW-UP */}
                <div className="space-y-2.5 p-3.5 bg-blue-500/5 border border-blue-500/20 rounded-xl">
                  <div className="flex items-center justify-between">
                    <label className="text-[11px] uppercase font-bold text-blue-400 flex items-center gap-1.5">
                      <Clock size={13} />
                      Lembrete de Retorno (Follow-up)
                    </label>
                    {modalFollowUpDate && (
                      <button
                        type="button"
                        onClick={() => { setModalFollowUpDate(''); setModalFollowUpNote(''); }}
                        className="text-[10px] text-red-400 hover:underline cursor-pointer"
                      >
                        Limpar Lembrete
                      </button>
                    )}
                  </div>

                  {/* Atalhos Rápidos */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] text-fg-faint">Atalhos:</span>
                    <button
                      type="button"
                      onClick={() => setQuickFollowUp(0)}
                      className="text-[10px] font-semibold px-2 py-0.5 rounded bg-surface-base border border-line-subtle hover:border-blue-400 text-fg transition-all"
                    >
                      Hoje
                    </button>
                    <button
                      type="button"
                      onClick={() => setQuickFollowUp(1)}
                      className="text-[10px] font-semibold px-2 py-0.5 rounded bg-surface-base border border-line-subtle hover:border-blue-400 text-fg transition-all"
                    >
                      Amanhã
                    </button>
                    <button
                      type="button"
                      onClick={() => setQuickFollowUp(3)}
                      className="text-[10px] font-semibold px-2 py-0.5 rounded bg-surface-base border border-line-subtle hover:border-blue-400 text-fg transition-all"
                    >
                      Em 3 dias
                    </button>
                    <button
                      type="button"
                      onClick={() => setQuickFollowUp(7)}
                      className="text-[10px] font-semibold px-2 py-0.5 rounded bg-surface-base border border-line-subtle hover:border-blue-400 text-fg transition-all"
                    >
                      Próxima semana
                    </button>
                    <button
                      type="button"
                      onClick={() => setQuickFollowUp(15)}
                      className="text-[10px] font-semibold px-2 py-0.5 rounded bg-surface-base border border-line-subtle hover:border-blue-400 text-fg transition-all"
                    >
                      Em 15 dias
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 pt-1">
                    <div>
                      <label className="text-[10px] text-fg-subtle block mb-1">Data agendada:</label>
                      <input
                        type="date"
                        value={modalFollowUpDate}
                        onChange={(e) => setModalFollowUpDate(e.target.value)}
                        className="w-full bg-surface-base border border-line-subtle rounded-lg px-2.5 py-1.5 text-body text-fg focus:border-blue-400 outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-fg-subtle block mb-1">Motivo do retorno:</label>
                      <input
                        type="text"
                        value={modalFollowUpNote}
                        onChange={(e) => setModalFollowUpNote(e.target.value)}
                        placeholder="Ex: Ligar para fechar proposta"
                        className="w-full bg-surface-base border border-line-subtle rounded-lg px-2.5 py-1.5 text-body text-fg focus:border-blue-400 outline-none"
                      />
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-3 border-t border-line-subtle">
                  {selectedLead.phone ? (
                    <a
                      href={`https://wa.me/${selectedLead.phone.replace(/\D/g, '')}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-micro font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-3 py-2 rounded-xl hover:bg-emerald-500/20 transition-colors"
                    >
                      <MessageSquare size={13} />
                      Abrir WhatsApp
                    </a>
                  ) : <span />}

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedLead(null)}
                      className="px-4 py-2 rounded-xl border border-line-subtle text-fg-subtle hover:text-fg hover:bg-surface-overlay text-body font-medium transition-colors cursor-pointer"
                    >
                      Cancelar
                    </button>
                    <button
                      type="submit"
                      disabled={isSaving}
                      className="px-4 py-2 rounded-xl bg-brand-solid text-black font-bold text-body hover:bg-brand-glow transition-all cursor-pointer disabled:opacity-50"
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

      {/* MODAL PARA CRIAR NOVA ETAPA DO FUNIL */}
      {mounted &&
        showAddStageModal &&
        createPortal(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-150">
            <div className="bg-surface-panel border border-line-subtle rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col">
              <div className="p-5 border-b border-line-subtle flex items-center justify-between">
                <div>
                  <h3 className="text-h3 text-fg font-bold">Nova Etapa do Funil</h3>
                  <p className="text-micro text-fg-subtle mt-0.5">Adicione uma coluna personalizada ao Pipeline</p>
                </div>
                <button
                  onClick={() => setShowAddStageModal(false)}
                  className="text-fg-subtle hover:text-fg p-1 font-bold cursor-pointer"
                >
                  <X size={18} />
                </button>
              </div>

              <form onSubmit={handleCreateStage} className="p-5 space-y-4">
                <div className="space-y-1.5">
                  <label className="text-[11px] uppercase font-bold text-fg-subtle">Nome da Etapa</label>
                  <input
                    type="text"
                    required
                    value={newStageLabel}
                    onChange={(e) => setNewStageLabel(e.target.value)}
                    placeholder="Ex: Proposta Enviada, Visita Agendada, Em Negociação..."
                    className="w-full bg-surface-base border border-line-subtle rounded-xl px-3 py-2 text-body text-fg focus:border-brand-ink outline-none"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] uppercase font-bold text-fg-subtle">Cor da Coluna</label>
                  <div className="flex items-center gap-2 pt-1">
                    {PRESET_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setNewStageColor(c)}
                        style={{ backgroundColor: c }}
                        className={cn(
                          "w-6 h-6 rounded-full border-2 transition-transform cursor-pointer",
                          newStageColor === c ? "scale-125 border-white shadow-lg" : "border-transparent hover:scale-110"
                        )}
                      />
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-3 border-t border-line-subtle">
                  <button
                    type="button"
                    onClick={() => setShowAddStageModal(false)}
                    className="px-4 py-2 rounded-xl border border-line-subtle text-fg-subtle hover:text-fg hover:bg-surface-overlay text-body font-medium transition-colors cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-xl bg-brand-solid text-black font-bold text-body hover:bg-brand-glow transition-all cursor-pointer"
                  >
                    Adicionar Coluna
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
