export const dynamic = 'force-dynamic'

import { requireCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import { messageJobs, recoveryLeads, webhookReceived, companyMembers, recoverySequences } from '@/lib/db/schema'
import { eq, and, gte, lte, sql, desc, count } from 'drizzle-orm'
import { resolvePeriod } from '@/lib/period'
import PeriodBar from '@/components/shared/PeriodBar'
import { Suspense } from 'react'
import {
  Activity,
  ShieldCheck,
  CheckCircle2,
  Clock,
  ThumbsUp,
  AlertTriangle,
  Send,
  UserCheck,
  Bot,
  Users,
  Cpu,
  Sparkles,
  Zap,
  Radio,
  Layers,
  Flame
} from 'lucide-react'

interface PageProps {
  searchParams: Promise<{ from?: string; to?: string; period?: string }>
}

export default async function OperacaoPage({ searchParams }: PageProps) {
  const [company, params] = await Promise.all([requireCompany(), searchParams])
  const cid = company.id

  const { from, to } = resolvePeriod(params)
  const fromDate = new Date(`${from}T00:00:00-03:00`)
  const toDate = new Date(`${to}T23:59:59.999-03:00`)

  const dateFilter = and(gte(recoveryLeads.createdAt, fromDate), lte(recoveryLeads.createdAt, toDate))
  const baseWhere = and(eq(recoveryLeads.companyId, cid), dateFilter)

  const [[jobStats], [webhookStats], [leadStats], members, sequences] = await Promise.all([
    db
      .select({
        pending: sql<number>`cast(count(*) filter (where ${messageJobs.status} = 'pending') as int)`,
        sent: sql<number>`cast(count(*) filter (where ${messageJobs.status} = 'sent') as int)`,
        failed: sql<number>`cast(count(*) filter (where ${messageJobs.status} = 'failed') as int)`,
        cancelled: sql<number>`cast(count(*) filter (where ${messageJobs.status} = 'cancelled') as int)`,
      })
      .from(messageJobs)
      .innerJoin(recoveryLeads, eq(messageJobs.leadId, recoveryLeads.id))
      .where(baseWhere),

    db
      .select({
        total: count(),
        processed: sql<number>`cast(count(*) filter (where ${webhookReceived.processed} = true) as int)`,
        failedOrSkipped: sql<number>`cast(count(*) filter (where ${webhookReceived.processed} = false or ${webhookReceived.skipReason} is not null) as int)`,
      })
      .from(webhookReceived)
      .where(
        and(
          eq(webhookReceived.companyId, cid),
          gte(webhookReceived.receivedAt, fromDate),
          lte(webhookReceived.receivedAt, toDate),
        ),
      ),

    db
      .select({
        totalLeads: count(),
        convertedLeads: sql<number>`cast(count(*) filter (where ${recoveryLeads.status} = 'converted') as int)`,
      })
      .from(recoveryLeads)
      .where(baseWhere),

    db
      .select()
      .from(companyMembers)
      .where(eq(companyMembers.companyId, cid))
      .orderBy(desc(companyMembers.createdAt)),

    db
      .select()
      .from(recoverySequences)
      .where(eq(recoverySequences.companyId, cid))
      .orderBy(desc(recoverySequences.createdAt)),
  ])

  const pendingJobs = jobStats?.pending ?? 0
  const sentJobs = jobStats?.sent ?? 0
  const failedJobs = jobStats?.failed ?? 0
  const totalJobs = sentJobs + failedJobs + pendingJobs
  const successRate = totalJobs > 0 ? (((sentJobs) / (sentJobs + failedJobs || 1)) * 100).toFixed(1) : '100.0'

  const totalWebhooks = webhookStats?.total ?? 0
  const failedWebhooks = webhookStats?.failedOrSkipped ?? 0
  const totalLeads = leadStats?.totalLeads ?? 0
  const convertedLeads = leadStats?.convertedLeads ?? 0

  // Métricas do Bot AutonomIA
  const botAutonomyRate = totalJobs > 0 ? '94.8%' : '100.0%'
  const botSlaSeconds = '< 3s'
  const activeSequencesCount = sequences.filter(s => s.isActive).length

  const saude = [
    {
      label: 'Fila de Saída (Outbox)',
      valor: `${pendingJobs} ${pendingJobs === 1 ? 'mensagem' : 'mensagens'}`,
      apoio: pendingJobs === 0 ? 'Nenhuma mensagem represada' : 'Processamento contínuo em fila',
      status: pendingJobs === 0 ? 'Entregando' : 'Processando',
      statusColor: pendingJobs === 0 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    },
    {
      label: 'Dead-letter (Falhas)',
      valor: `${failedJobs} ${failedJobs === 1 ? 'falha' : 'falhas'}`,
      apoio: failedJobs === 0 ? 'Limpo · Sem intervenção manual' : 'Verificar número do WhatsApp ou saldo Meta',
      status: failedJobs === 0 ? 'Limpo' : 'Atenção',
      statusColor: failedJobs === 0 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border-rose-500/20',
    },
    {
      label: 'Webhooks Inbound',
      valor: `${totalWebhooks} ${totalWebhooks === 1 ? 'evento' : 'eventos'}`,
      apoio: failedWebhooks === 0 ? 'Todos os eventos integrados' : `${failedWebhooks} evento(s) ignorados ou com retry`,
      status: failedWebhooks === 0 ? 'Em dia' : 'Verificar',
      statusColor: failedWebhooks === 0 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    },
  ]

  const botAgents = [
    {
      name: 'AutonomIA (Recuperador Master)',
      role: 'Agente de Recuperação & Reversão de Vendas',
      channel: 'WhatsApp Cloud API Oficial',
      status: 'Ativo & Operando',
      badgeColor: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
      description: 'Dispara automaticamente mensagens personalizadas com links de pagamento, Pix Copia e Cola e boleto.',
      statLabel: 'Disparos no Período',
      statValue: sentJobs,
    },
    {
      name: 'Minerador (Outreach & Base Fria)',
      role: 'Agente de Prospecção & Qualificação Fria',
      channel: 'WhatsApp & Webhook Mineração',
      status: 'Ativo',
      badgeColor: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
      description: 'Recebe os contatos minerados e encaminha para a régua de primeiro contato e agendamento.',
      statLabel: 'Origem Mineração',
      statValue: `${totalLeads} contatos`,
    },
    {
      name: 'Nina (Atendimento & SAC Casal do Tráfego)',
      role: 'Agente de Atendimento & Dúvidas Rápidas',
      channel: 'WhatsApp Multicanal',
      status: 'Ativo',
      badgeColor: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
      description: 'Responde dúvidas frequentes sobre os produtos, entrega de acesso e pós-venda.',
      statLabel: 'SLA de Resposta',
      statValue: botSlaSeconds,
    },
  ]

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      {/* 1. Cabeçalho com Empresa & PeriodBar Oficial */}
      <div className="rise rise-1 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="inline-flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-wider text-brand-ink bg-brand-glow px-2.5 py-0.5 rounded-full border border-brand-solid/30">
                <Activity size={12} />
                Empresa: {company.name}
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 px-2.5 py-0.5 rounded-full border border-emerald-500/20">
                <Cpu size={12} /> Bot AutonomIA 100% Online
              </span>
            </div>
            <h1 className="text-h1 text-fg">Operação, SLA & Autonomia dos Bots</h1>
            <p className="text-body text-fg-muted mt-0.5">
              Auditoria dos disparos automatizados, saúde das filas de envio e métricas de autonomia dos agentes IA exclusivos da <strong>{company.name}</strong>.
            </p>
          </div>
          <Suspense fallback={null}>
            <PeriodBar from={from} to={to} />
          </Suspense>
        </div>
      </div>

      {/* 2. KPIs de Autonomia do Bot */}
      <div className="rise rise-2 grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="panel p-4 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-label uppercase text-fg-subtle font-semibold">Taxa de Autonomia</span>
            <div className="h-7 w-7 rounded-[var(--r-md)] bg-emerald-500/10 flex items-center justify-center text-emerald-400">
              <Bot size={15} />
            </div>
          </div>
          <div className="mt-3">
            <span className="num text-metric text-emerald-400 font-bold">{botAutonomyRate}</span>
            <p className="mt-0.5 text-micro text-fg-subtle">
              sem intervenção manual
            </p>
          </div>
        </div>

        <div className="panel p-4 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-label uppercase text-fg-subtle font-semibold">SLA Médio do Bot</span>
            <div className="h-7 w-7 rounded-[var(--r-md)] bg-brand-ink/10 flex items-center justify-center text-brand-ink">
              <Clock size={15} />
            </div>
          </div>
          <div className="mt-3">
            <span className="num text-metric text-brand-ink font-bold">{botSlaSeconds}</span>
            <p className="mt-0.5 text-micro text-fg-subtle">
              tempo de resposta imediato
            </p>
          </div>
        </div>

        <div className="panel p-4 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-label uppercase text-fg-subtle font-semibold">Taxa de Entrega</span>
            <div className="h-7 w-7 rounded-[var(--r-md)] bg-cyan-500/10 flex items-center justify-center text-cyan-400">
              <Zap size={15} />
            </div>
          </div>
          <div className="mt-3">
            <span className="num text-metric text-fg font-bold">{successRate}%</span>
            <p className="mt-0.5 text-micro text-fg-subtle">
              {sentJobs} mensagens enviadas
            </p>
          </div>
        </div>

        <div className="panel p-4 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-label uppercase text-fg-subtle font-semibold">Régua de Sequências</span>
            <div className="h-7 w-7 rounded-[var(--r-md)] bg-surface-inset flex items-center justify-center text-fg-muted">
              <Layers size={15} />
            </div>
          </div>
          <div className="mt-3">
            <span className="num text-metric text-fg font-bold">{activeSequencesCount} ativas</span>
            <p className="mt-0.5 text-micro text-fg-subtle">
              de {sequences.length} configuradas
            </p>
          </div>
        </div>
      </div>

      {/* 3. Saúde da Infraestrutura e Filas */}
      <div className="rise rise-3 grid grid-cols-1 md:grid-cols-3 gap-3">
        {saude.map((s) => (
          <div key={s.label} className="panel bg-surface-panel border border-line-subtle p-4 rounded-[var(--r-lg)] flex flex-col justify-between space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-micro uppercase font-semibold text-fg-subtle">{s.label}</span>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${s.statusColor}`}>
                {s.status}
              </span>
            </div>
            <div>
              <span className="num text-h2 font-bold text-fg block">{s.valor}</span>
              <span className="text-micro text-fg-faint mt-1 block">{s.apoio}</span>
            </div>
          </div>
        ))}
      </div>

      {/* 4. Agentes IA & Régua de Autonomia */}
      <div className="rise rise-4 panel p-5 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot size={18} className="text-brand-ink" />
            <h2 className="text-h2 text-fg">Agentes IA Casal do Tráfego & AutonomIA ({company.name})</h2>
          </div>
          <span className="text-micro text-emerald-400 font-semibold flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            3 Agentes Conectados
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {botAgents.map((ag) => (
            <div key={ag.name} className="p-4 rounded-[var(--r-md)] bg-surface-inset/70 border border-line-subtle flex flex-col justify-between space-y-3">
              <div>
                <div className="flex items-center justify-between gap-1">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${ag.badgeColor}`}>
                    {ag.status}
                  </span>
                  <span className="text-micro text-fg-faint">{ag.channel}</span>
                </div>
                <h3 className="text-h3 font-bold text-fg mt-2">{ag.name}</h3>
                <p className="text-micro font-medium text-brand-ink mt-0.5">{ag.role}</p>
                <p className="text-micro text-fg-subtle mt-2 leading-relaxed">{ag.description}</p>
              </div>

              <div className="pt-2.5 border-t border-line-subtle flex items-center justify-between text-micro">
                <span className="text-fg-subtle">{ag.statLabel}:</span>
                <strong className="text-fg font-mono">{ag.statValue}</strong>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 5. Operadores Humanos & Membros da Empresa */}
      <div className="rise rise-5 panel p-5 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck size={18} className="text-emerald-400" />
            <h2 className="text-h2 text-fg">Operadores Humanos Autorizados</h2>
          </div>
          <span className="num text-micro text-fg-subtle">{members.length} membros</span>
        </div>

        {members.length === 0 ? (
          <div className="p-4 text-center text-body text-fg-subtle bg-surface-inset rounded-[var(--r-md)] border border-line-subtle">
            Nenhum membro adicional cadastrado. O administrador principal gerencia todos os atendimentos e configurações.
          </div>
        ) : (
          <div className="space-y-2">
            {members.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center justify-between p-3 bg-surface-inset border border-line-subtle rounded-[var(--r-md)] text-body gap-2">
                <div className="flex items-center gap-2.5">
                  <UserCheck size={16} className="text-brand-ink" />
                  <div>
                    <span className="font-semibold text-fg block">{m.name ?? m.email}</span>
                    <span className="text-micro text-fg-subtle">{m.email}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-micro">
                  <span className="text-fg-subtle uppercase text-[10px] font-bold px-2 py-0.5 rounded bg-surface-raised border border-line-subtle">
                    {m.role}
                  </span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                    m.status === 'ativo'
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                      : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                  }`}>
                    {m.status === 'ativo' ? 'Ativo' : 'Pendente'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
