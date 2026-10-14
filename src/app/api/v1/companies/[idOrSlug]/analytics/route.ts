export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { agentActivityLogs, recoveryLeads, messageJobs } from '@/lib/db/schema'
import { authenticateAgentRequest } from '@/lib/agent-auth'
import { eq, and, count, sql, gte, lte } from 'drizzle-orm'
import { dashboardLeadStatsSelect, resolveDashboardBusinessModel } from '@/lib/dashboard/lead-stats'
import { resolveAnalyticsPeriod } from '@/lib/analytics-period'

type Params = { params: Promise<{ idOrSlug: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  const period = resolveAnalyticsPeriod(from, to)
  if ('error' in period) {
    return NextResponse.json({ error: period.error, code: 'INVALID_PERIOD' }, { status: 400 })
  }
  const { fromDate, toDate } = period

  const cid = context.company.id
  const baseWhere = and(
    eq(recoveryLeads.companyId, cid),
    gte(recoveryLeads.createdAt, fromDate),
    lte(recoveryLeads.createdAt, toDate)
  )

  const businessModel = resolveDashboardBusinessModel(context.company.slug)
  const isGramado = businessModel === 'gramado'
  const isLucas = businessModel === 'lucas'
  const isAgencia = businessModel === 'agencia'

  const [[leadStats], [jobStats], activityRows] = await Promise.all([
    db
      .select({
        ...dashboardLeadStatsSelect(businessModel),
        total: count(),
      })
      .from(recoveryLeads)
      .where(baseWhere),

    db
      .select({
        pending: sql<number>`cast(count(*) filter (where ${messageJobs.status} = 'pending') as int)`,
        sent: sql<number>`cast(count(*) filter (where ${messageJobs.status} = 'sent') as int)`,
        failed: sql<number>`cast(count(*) filter (where ${messageJobs.status} = 'failed') as int)`,
      })
      .from(messageJobs)
      .innerJoin(recoveryLeads, eq(messageJobs.leadId, recoveryLeads.id))
      .where(baseWhere),

    db
      .select({
        agentId: agentActivityLogs.agentId,
        agentName: agentActivityLogs.agentName,
        action: agentActivityLogs.action,
        total: count(),
      })
      .from(agentActivityLogs)
      .where(and(
        eq(agentActivityLogs.companyId, cid),
        gte(agentActivityLogs.createdAt, fromDate),
        lte(agentActivityLogs.createdAt, toDate)
      ))
      .groupBy(agentActivityLogs.agentId, agentActivityLogs.agentName, agentActivityLogs.action),
  ])

  const total = leadStats?.total ?? 0
  const fechados = leadStats?.fechadosTotal ?? 0
  const valorFechadoCents = Number(leadStats?.valorFechadoCents ?? 0)
  const conversionRate = total > 0 ? ((fechados / total) * 100).toFixed(1) : '0.0'

  let modelMetrics = {}
  if (isGramado) {
    modelMetrics = {
      model: 'restaurante_reservas',
      reservasConfirmadas: fechados,
      pessoasEstimadas: fechados * 3,
      consumoEstimadoCents: valorFechadoCents > 0 ? valorFechadoCents : fechados * 18000,
      taxaConversaoReservas: `${conversionRate}%`,
    }
  } else if (isLucas) {
    modelMetrics = {
      model: 'clinica_agendamentos',
      consultasAgendadas: fechados,
      novosPacientes: total,
      taxaAgendamento: `${conversionRate}%`,
    }
  } else if (isAgencia) {
    modelMetrics = {
      model: 'agencia_contratos_b2b',
      contratosFechados: fechados,
      valorContratosCents: valorFechadoCents,
      propostasAndamento: leadStats?.qualificadosTotal ?? 0,
      taxaConversaoComercial: `${conversionRate}%`,
    }
  } else {
    modelMetrics = {
      model: 'infoprodutos_recuperacao',
      vendasRecuperadas: fechados,
      valorRecuperadoCents: valorFechadoCents,
      taxaConversao: `${conversionRate}%`,
    }
  }

  const agents = new Map<string, {
    id: string | null
    name: string
    totalActions: number
    actions: Record<string, number>
  }>()

  for (const row of activityRows) {
    const key = row.agentId ?? row.agentName
    const existing = agents.get(key) ?? {
      id: row.agentId,
      name: row.agentName,
      totalActions: 0,
      actions: {},
    }
    const actionTotal = Number(row.total)
    existing.totalActions += actionTotal
    existing.actions[row.action] = actionTotal
    agents.set(key, existing)
  }

  return NextResponse.json({
    ok: true,
    company: { id: context.company.id, slug: context.company.slug, name: context.company.name },
    period: { from: fromDate.toISOString(), to: toDate.toISOString() },
    totalLeads: total,
    closingStats: modelMetrics,
    outbox: jobStats || { sent: 0, pending: 0, failed: 0 },
    agentMetrics: {
      source: 'agent_activity_logs',
      totalActions: [...agents.values()].reduce((total, agent) => total + agent.totalActions, 0),
      agents: [...agents.values()],
    },
  })
}
