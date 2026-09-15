export const dynamic = 'force-dynamic'

import { requireCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import { messageJobs, recoveryLeads, webhookReceived, companyMembers, recoverySequences } from '@/lib/db/schema'
import { eq, and, gte, lte, sql, desc, count } from 'drizzle-orm'
import { resolvePeriod } from '@/lib/period'
import PeriodBar from '@/components/shared/PeriodBar'
import { Suspense } from 'react'
import { Activity, ShieldCheck, CheckCircle2, Clock, ThumbsUp, AlertTriangle, Send, UserCheck, Bot, Users } from 'lucide-react'

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

  const [[jobStats], [webhookStats], members, sequences] = await Promise.all([
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
      apoio: failedJobs === 0 ? 'Limpo · Sem intervenção manual necessária' : 'Necessita verificação de número ou saldo',
      status: failedJobs === 0 ? 'Limpo' : 'Atenção',
      statusColor: failedJobs === 0 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20',
    },
    {
      label: 'Webhooks Inbound',
      valor: `${totalWebhooks} ${totalWebhooks === 1 ? 'evento' : 'eventos'}`,
      apoio: failedWebhooks === 0 ? 'Todos os eventos integrados e em dia' : `${failedWebhooks} evento(s) ignorados ou com falha`,
      status: failedWebhooks === 0 ? 'Em dia' : 'Verificar',
      statusColor: failedWebhooks === 0 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    },
  ]

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      {/* 1. Cabeçalho com Empresa & PeriodBar */}
      <div className="rise rise-1 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="inline-flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-wider text-brand-ink bg-brand-glow px-2.5 py-0.5 rounded-full border border-brand-solid/30">
                <Activity size={12} />
                Empresa: {company.name}
              </span>
            </div>
            <h1 className="text-h1 text-fg">Operação & SLA</h1>
            <p className="text-body text-fg-muted mt-0.5">
              Auditoria das ações automatizadas, saúde das filas de envio e integridade da infraestrutura exclusiva da empresa.
            </p>
          </div>
          <Suspense fallback={null}>
            <PeriodBar from={from} to={to} />
          </Suspense>
        </div>
      </div>

      {/* 2. Saúde da Entrega */}
      <div className="rise rise-2 grid grid-cols-1 md:grid-cols-3 gap-[var(--space-gutter)]">
        {saude.map((s) => (
          <div key={s.label} className="card bg-surface-raised border border-line-subtle p-5 rounded-2xl flex flex-col justify-between space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-micro uppercase font-semibold text-fg-subtle">{s.label}</span>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${s.statusColor}`}>
                {s.status}
              </span>
            </div>
            <div>
              <span className="num text-h3 font-bold text-fg block">{s.valor}</span>
              <span className="text-micro text-fg-faint mt-1 block">{s.apoio}</span>
            </div>
          </div>
        ))}
      </div>

      {/* 3. Agentes de Recuperação & Automações Ativas */}
      <div className="rise rise-3 card-section p-5">
        <h3 className="text-h3 text-fg font-bold mb-4 flex items-center gap-2">
          <Bot size={18} className="text-brand-ink" />
          Régua de Automação & Agente IA ({company.name})
        </h3>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between p-3.5 bg-surface-raised border border-line-subtle rounded-xl text-body gap-2">
            <div className="flex items-center gap-2.5">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              <div>
                <span className="font-semibold text-fg block">AutonomIA (Agente SAC & Recuperação)</span>
                <span className="text-micro text-fg-subtle">Disparos e atendimento automatizado via WhatsApp</span>
              </div>
            </div>
            <div className="flex items-center gap-4 text-micro">
              <span className="text-fg-subtle">Disparos no Período: <strong className="text-fg">{sentJobs}</strong></span>
              <span className="text-fg-subtle">Taxa de Sucesso: <strong className="text-emerald-400">{successRate}%</strong></span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                Ativo
              </span>
            </div>
          </div>

          {sequences.map((seq) => (
            <div key={seq.id} className="flex flex-wrap items-center justify-between p-3 bg-surface-raised border border-line-subtle rounded-xl text-body gap-2">
              <div className="flex items-center gap-2.5">
                <span className={`h-2 w-2 rounded-full ${seq.isActive ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                <span className="font-medium text-fg">{seq.name}</span>
                <span className="text-micro font-mono uppercase text-fg-faint">({seq.eventType})</span>
              </div>
              <div className="flex items-center gap-3 text-micro">
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                  seq.isActive
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                    : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                }`}>
                  {seq.isActive ? 'Sequência Ativa' : 'Pausada'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 4. Operadores Humanos & Membros da Empresa */}
      <div className="rise rise-4 card-section p-5">
        <h3 className="text-h3 text-fg font-bold mb-4 flex items-center gap-2">
          <ShieldCheck size={18} className="text-emerald-400" />
          Membros & Operadores Autorizados
        </h3>
        {members.length === 0 ? (
          <div className="p-4 text-center text-body text-fg-subtle bg-surface-raised border border-line-subtle rounded-xl">
            Nenhum membro adicional cadastrado para esta empresa. Administrador principal possui acesso total.
          </div>
        ) : (
          <div className="space-y-2">
            {members.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center justify-between p-3 bg-surface-raised border border-line-subtle rounded-xl text-body gap-2">
                <div className="flex items-center gap-2.5">
                  <UserCheck size={16} className="text-brand-ink" />
                  <div>
                    <span className="font-semibold text-fg block">{m.name ?? m.email}</span>
                    <span className="text-micro text-fg-subtle">{m.email}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-micro">
                  <span className="text-fg-subtle uppercase text-[10px] font-bold px-2 py-0.5 rounded bg-surface-inset border border-line-subtle">
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
