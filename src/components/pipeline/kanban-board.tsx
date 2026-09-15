'use client'

import { useState } from 'react'
import {
  MessageSquare,
  Mail,
  DollarSign,
  Calendar,
  ExternalLink,
  ChevronRight,
  Sparkles,
  Bot,
  Filter,
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
  agentName?: string
  channel?: 'whatsapp' | 'instagram' | 'email'
  updatedAt?: string | Date | null
}

const STAGES = [
  { id: 'novo_contato', label: 'Novo Contato', color: '#3987e5', badge: 'bg-blue-500/10 text-blue-400 border-blue-500/20' },
  { id: 'em_atendimento', label: 'Em Atendimento', color: '#d95926', badge: 'bg-orange-500/10 text-orange-400 border-orange-500/20' },
  { id: 'qualificado', label: 'Qualificado', color: '#199e70', badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
  { id: 'agendado', label: 'Agendado', color: '#9085e9', badge: 'bg-purple-500/10 text-purple-400 border-purple-500/20' },
  { id: 'fechado', label: 'Fechado', color: '#008300', badge: 'bg-green-500/10 text-green-400 border-green-500/20' },
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

function getPlatformBadge(platform?: string | null) {
  const p = (platform || 'hotmart').toLowerCase()
  if (p.includes('hotmart')) {
    return <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-400 border border-orange-500/20">Hotmart</span>
  }
  if (p.includes('kiwify')) {
    return <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Kiwify</span>
  }
  if (p.includes('greenn')) {
    return <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">Greenn</span>
  }
  if (p.includes('zouti')) {
    return <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">Zouti</span>
  }
  return <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-white/5 text-fg-subtle border border-white/10">{platform || 'SAC'}</span>
}

export function KanbanBoard({ initialLeads = [] }: { initialLeads: KanbanLead[] }) {
  const [leads, setLeads] = useState<KanbanLead[]>(() => {
    if (initialLeads.length > 0) return initialLeads
    // Fallback com distribuição ilustrativa inicial se não houver leads ainda
    return [
      { id: 1, name: 'Lucas Andrade', phone: '5511987654321', productName: 'Mentoria Tráfego Pro', productValue: 199700, eventType: 'carrinho_abandonado', platform: 'Hotmart', stage: 'novo_contato', channel: 'whatsapp', agentName: 'AutonomIA' },
      { id: 2, name: 'Camila Rodrigues', phone: '5521998877665', productName: 'Curso Estratégia 10x', productValue: 49700, eventType: 'cartao_recusado', platform: 'Kiwify', stage: 'em_atendimento', channel: 'whatsapp', agentName: 'Bella' },
      { id: 3, name: 'Rodrigo Silveira', phone: '5531988771122', productName: 'Comunidade Escala', productValue: 99700, eventType: 'pix', platform: 'Greenn', stage: 'qualificado', channel: 'instagram', agentName: 'Casal do Tráfego' },
      { id: 4, name: 'Juliana Costa', phone: '5541991234567', productName: 'Mentoria Tráfego Pro', productValue: 199700, eventType: 'boleto', platform: 'Hotmart', stage: 'agendado', channel: 'whatsapp', agentName: 'AutonomIA' },
      { id: 5, name: 'Marcelo Pereira', phone: '5581987612345', productName: 'Acelerador de Vendas', productValue: 29700, eventType: 'compra_aprovada', platform: 'Kiwify', stage: 'fechado', channel: 'email', agentName: 'AutonomIA' },
    ]
  })

  const [filterChannel, setFilterChannel] = useState<string>('all')
  const [filterAgent, setFilterAgent] = useState<string>('all')
  const [draggedId, setDraggedId] = useState<number | null>(null)

  const filteredLeads = leads.filter((item) => {
    if (filterChannel !== 'all' && item.channel !== filterChannel) return false
    if (filterAgent !== 'all' && item.agentName !== filterAgent) return false
    return true
  })

  function moveStage(leadId: number, targetStage: string) {
    setLeads((prev) =>
      prev.map((l) => (l.id === leadId ? { ...l, stage: targetStage } : l))
    )
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

  const agentsList = Array.from(new Set(leads.map((l) => l.agentName || 'AutonomIA')))

  return (
    <div className="flex flex-col gap-4">
      {/* Controles do Kanban: Filtros por Agente e Canal */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-surface-raised border border-line-subtle rounded-[var(--r-md)] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-micro font-medium uppercase text-fg-subtle mr-1">
            <Filter size={13} />
            Filtros:
          </span>

          {/* Filtro de Agentes */}
          <div className="flex items-center gap-1 bg-surface-base border border-line-subtle rounded-[var(--r-sm)] p-1 text-micro">
            <Bot size={13} className="text-brand-ink ml-1" />
            <select
              value={filterAgent}
              onChange={(e) => setFilterAgent(e.target.value)}
              className="bg-transparent text-fg text-micro font-medium focus:outline-none cursor-pointer pr-1"
            >
              <option value="all">Todos os Agentes</option>
              {agentsList.map((agent) => (
                <option key={agent} value={agent}>{agent}</option>
              ))}
            </select>
          </div>

          {/* Filtro de Canais */}
          <div className="flex items-center gap-1 bg-surface-base border border-line-subtle rounded-[var(--r-sm)] p-1 text-micro">
            <select
              value={filterChannel}
              onChange={(e) => setFilterChannel(e.target.value)}
              className="bg-transparent text-fg text-micro font-medium focus:outline-none cursor-pointer px-1"
            >
              <option value="all">Todos os Canais</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="instagram">Instagram</option>
              <option value="email">E-mail</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-micro text-st-positivo font-medium bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-full">
            <Sparkles size={13} />
            Atendimento Automatizado Ativo
          </span>
        </div>
      </div>

      {/* Quadro de Colunas Kanban */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3 overflow-x-auto pb-2 scroll-thin">
        {STAGES.map((stage) => {
          const stageLeads = filteredLeads.filter((l) => l.stage === stage.id)
          const stageTotalValue = stageLeads.reduce((acc, curr) => acc + (curr.productValue || 0), 0)

          return (
            <div
              key={stage.id}
              onDragOver={handleDragOver}
              onDrop={() => handleDrop(stage.id)}
              className="flex flex-col rounded-[var(--r-md)] bg-surface-base border border-line-subtle min-w-[240px] md:min-w-0"
            >
              {/* Topo da Coluna */}
              <div
                className="p-3 border-b border-line-subtle flex items-center justify-between"
                style={{ borderTop: `3px solid ${stage.color}` }}
              >
                <div>
                  <h3 className="text-body font-semibold text-fg flex items-center gap-1.5">
                    {stage.label}
                  </h3>
                  <p className="text-micro text-fg-subtle">
                    {formatBRL(stageTotalValue)}
                  </p>
                </div>
                <span className="num flex h-6 w-6 items-center justify-center rounded-full bg-surface-raised border border-line-subtle text-micro font-bold text-fg">
                  {stageLeads.length}
                </span>
              </div>

              {/* Lista de Cards da Coluna */}
              <div className="flex-1 p-2 space-y-2 min-h-[320px] max-h-[580px] overflow-y-auto scroll-thin">
                {stageLeads.length === 0 ? (
                  <div className="flex items-center justify-center h-28 border border-dashed border-line-subtle rounded-[var(--r-sm)] text-micro text-fg-faint">
                    Arraste leads para cá
                  </div>
                ) : (
                  stageLeads.map((lead) => (
                    <div
                      key={lead.id}
                      draggable
                      onDragStart={() => handleDragStart(lead.id)}
                      className="card bg-surface-raised border border-line-subtle p-3 rounded-[var(--r-sm)] shadow-sm hover:border-brand-ink/40 transition-all cursor-grab active:cursor-grabbing space-y-2"
                    >
                      {/* Selos de Origem e Canal */}
                      <div className="flex items-center justify-between gap-1">
                        {getPlatformBadge(lead.platform)}
                        <span className="flex items-center gap-1 text-[11px] text-fg-subtle">
                          {getChannelIcon(lead.channel)}
                          <span className="capitalize">{lead.channel || 'WhatsApp'}</span>
                        </span>
                      </div>

                      {/* Dados do Contato */}
                      <div>
                        <h4 className="text-body font-semibold text-fg truncate">
                          {lead.name || 'Contato sem nome'}
                        </h4>
                        <p className="text-micro text-fg-subtle truncate">
                          {lead.productName || 'Produto Geral'}
                        </p>
                      </div>

                      {/* Valor e Agente */}
                      <div className="flex items-center justify-between text-micro pt-1 border-t border-line-subtle">
                        <span className="num font-bold text-brand-ink flex items-center">
                          {formatBRL(lead.productValue)}
                        </span>
                        <span className="inline-flex items-center gap-1 text-[10px] text-fg-muted font-medium bg-surface-inset px-1.5 py-0.5 rounded">
                          <Bot size={11} className="text-fg-subtle" />
                          {lead.agentName || 'AutonomIA'}
                        </span>
                      </div>

                      {/* Ações Rápidas */}
                      <div className="flex items-center justify-between pt-1">
                        {lead.phone && (
                          <a
                            href={`https://wa.me/${lead.phone.replace(/\D/g, '')}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[11px] text-emerald-400 hover:text-emerald-300 font-medium"
                          >
                            <MessageSquare size={12} />
                            WhatsApp
                          </a>
                        )}

                        {/* Botão de Avançar Etapa */}
                        <div className="flex items-center gap-0.5">
                          {STAGES.indexOf(stage) < STAGES.length - 1 && (
                            <button
                              onClick={() => {
                                const nextIndex = STAGES.indexOf(stage) + 1
                                moveStage(lead.id, STAGES[nextIndex].id)
                              }}
                              title="Avançar Etapa"
                              className="focus-ring p-1 rounded bg-surface-inset hover:bg-surface-overlay text-fg-subtle hover:text-fg transition-colors"
                            >
                              <ChevronRight size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
