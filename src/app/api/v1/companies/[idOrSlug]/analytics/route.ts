export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { appointmentMirror, gramadoReservations, recoveryLeads, messageJobs } from '@/lib/db/schema'
import { authenticateAgentRequest } from '@/lib/agent-auth'
import { eq, and, count, sql, gte, lte, inArray, isNull } from 'drizzle-orm'
import { GRAMADO_VALID_RESERVATION_STATUSES } from '@/lib/dashboard/gramado-reservations'
import { dashboardLeadStatsSelect, resolveDashboardBusinessModel } from '@/lib/dashboard/lead-stats'
import { calculateConversionRate } from '@/lib/dashboard/conversion-rate'
import { dateKeyForAnalytics, gramadoInboundConversationInPeriodSql, gramadoMessageCountSql, gramadoReservationInPeriodSql } from '@/lib/dashboard/gramado-conversion'
import { resolveAnalyticsPeriod } from '@/lib/analytics-period'
import { loadAgentMetrics } from '@/lib/agent-metrics'

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
  const gramadoFromKey = dateKeyForAnalytics(fromDate, from)
  const gramadoToKey = dateKeyForAnalytics(toDate, to)
  const gramadoFromDate = new Date(`${gramadoFromKey}T00:00:00-03:00`)
  const gramadoToDate = new Date(`${gramadoToKey}T23:59:59.999-03:00`)
  const gramadoFromDateIso = gramadoFromDate.toISOString()
  const gramadoToDateIso = gramadoToDate.toISOString()

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
  const leadPeriodWhere = isLucas
    ? and(
        eq(recoveryLeads.companyId, cid),
        gte(recoveryLeads.firstContactAt, fromDate),
        lte(recoveryLeads.firstContactAt, toDate),
      )
    : baseWhere

  const [[leadStats], [gramadoConversationStats], [gramadoReservationStats], [lucasAppointmentStats], [jobStats], agentMetrics] = await Promise.all([
    db
      .select({
        ...dashboardLeadStatsSelect(businessModel),
        total: count(),
      })
      .from(recoveryLeads)
      .where(leadPeriodWhere),

    isGramado
      ? db
          .select({
            total: sql<number>`cast(count(distinct ${recoveryLeads.id}) as int)`,
            converteu: sql<number>`cast(count(distinct ${recoveryLeads.id}) filter (where ${gramadoReservationInPeriodSql(gramadoFromKey, gramadoToKey)}) as int)`,
            avancou: sql<number>`cast(count(distinct ${recoveryLeads.id}) filter (where ${gramadoMessageCountSql} >= 4) as int)`,
          })
          .from(recoveryLeads)
          .where(and(
            eq(recoveryLeads.companyId, cid),
            gramadoInboundConversationInPeriodSql(gramadoFromDateIso, gramadoToDateIso),
          ))
      : Promise.resolve([{ total: 0, converteu: 0, avancou: 0 }]),

    isGramado
      ? db
          .select({ totalReservas: sql<number>`cast(count(*) as int)` })
          .from(gramadoReservations)
          .where(and(
            eq(gramadoReservations.companyId, cid),
            gte(gramadoReservations.data, gramadoFromKey),
            lte(gramadoReservations.data, gramadoToKey),
            inArray(gramadoReservations.status, GRAMADO_VALID_RESERVATION_STATUSES),
          ))
      : Promise.resolve([{ totalReservas: 0 }]),

    isLucas
      ? db
          .select({ totalAgendamentos: sql<number>`cast(count(*) as int)` })
          .from(appointmentMirror)
          .where(and(
            eq(appointmentMirror.companyId, cid),
            gte(appointmentMirror.consultationAt, fromDate),
            lte(appointmentMirror.consultationAt, toDate),
            isNull(appointmentMirror.cancelledAt),
            sql`lower(trim(${appointmentMirror.status})) not in ('cancelado', 'cancelada', 'cancelled')`,
          ))
      : Promise.resolve([{ totalAgendamentos: 0 }]),

    db
      .select({
        pending: sql<number>`cast(count(*) filter (where ${messageJobs.status} = 'pending') as int)`,
        sent: sql<number>`cast(count(*) filter (where ${messageJobs.status} = 'sent') as int)`,
        failed: sql<number>`cast(count(*) filter (where ${messageJobs.status} = 'failed') as int)`,
      })
      .from(messageJobs)
      .innerJoin(recoveryLeads, eq(messageJobs.leadId, recoveryLeads.id))
      .where(baseWhere),

    loadAgentMetrics(cid, fromDate, toDate),
  ])

  const total = isGramado ? Number(gramadoConversationStats?.total ?? 0) : (leadStats?.total ?? 0)
  const fechados = isGramado
    ? Number(gramadoReservationStats?.totalReservas ?? 0)
    : isLucas
      ? Number(lucasAppointmentStats?.totalAgendamentos ?? 0)
      : (leadStats?.fechadosTotal ?? 0)
  const valorFechadoCents = Number(leadStats?.valorFechadoCents ?? 0)
  const conversionRate = calculateConversionRate(fechados, total)

  let modelMetrics = {}
  if (isGramado) {
    modelMetrics = {
      model: 'restaurante_reservas',
      reservasConfirmadas: fechados,
      pessoasEstimadas: fechados * 3,
      consumoEstimadoCents: valorFechadoCents > 0 ? valorFechadoCents : fechados * 18000,
      taxaConversaoReservas: conversionRate.label,
    }
  } else if (isLucas) {
    modelMetrics = {
      model: 'clinica_agendamentos',
      consultasAgendadas: fechados,
      novosPacientes: total,
      taxaAgendamento: conversionRate.label,
    }
  } else if (isAgencia) {
    modelMetrics = {
      model: 'agencia_contratos_b2b',
      contratosFechados: fechados,
      valorContratosCents: valorFechadoCents,
      propostasAndamento: leadStats?.qualificadosTotal ?? 0,
      taxaConversaoComercial: conversionRate.label,
    }
  } else {
    modelMetrics = {
      model: 'infoprodutos_recuperacao',
      vendasRecuperadas: fechados,
      valorRecuperadoCents: valorFechadoCents,
      taxaConversao: conversionRate.label,
    }
  }

  return NextResponse.json({
    ok: true,
    company: { id: context.company.id, slug: context.company.slug, name: context.company.name },
    period: {
      from: isGramado ? gramadoFromDateIso : fromDate.toISOString(),
      to: isGramado ? gramadoToDateIso : toDate.toISOString(),
    },
    totalLeads: total,
    closingStats: modelMetrics,
    outbox: jobStats || { sent: 0, pending: 0, failed: 0 },
    agentMetrics,
  })
}
