export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads, messageJobs } from '@/lib/db/schema'
import { authenticateAgentRequest } from '@/lib/agent-auth'
import { eq, and, count, sql, gte, lte } from 'drizzle-orm'

type Params = { params: Promise<{ idOrSlug: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 3600 * 1000)
  const toDate = to ? new Date(to) : new Date()

  const cid = context.company.id
  const baseWhere = and(
    eq(recoveryLeads.companyId, cid),
    gte(recoveryLeads.createdAt, fromDate),
    lte(recoveryLeads.createdAt, toDate)
  )

  const isGramado = context.company.slug.includes('gramado')
  const isLucas = context.company.slug.includes('lucas')
  const isAgencia = context.company.slug.includes('casal') || context.company.slug.includes('gastao')

  const [[leadStats], [jobStats]] = await Promise.all([
    db
      .select({
        total: count(),
        fechadosTotal: sql<number>`cast(count(*) filter (where ${recoveryLeads.status} in ('converted', 'completed') or ${recoveryLeads.eventType} in ('compra_aprovada', 'reserva_confirmada', 'agendado') or ${recoveryLeads.pipelineStage} in ('fechado', 'agendado')) as int)`,
        valorFechadoCents: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}) filter (where ${recoveryLeads.status} in ('converted', 'completed') or ${recoveryLeads.eventType} in ('compra_aprovada', 'reserva_confirmada') or ${recoveryLeads.pipelineStage} in ('fechado', 'agendado')), 0) as bigint)`,
        qualificadosTotal: sql<number>`cast(count(*) filter (where ${recoveryLeads.pipelineStage} in ('qualificado', 'agendado', 'em_atendimento') or ${recoveryLeads.eventType} in ('pix', 'boleto', 'agendamento')) as int)`,
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

  return NextResponse.json({
    ok: true,
    company: { id: context.company.id, slug: context.company.slug, name: context.company.name },
    period: { from: fromDate.toISOString(), to: toDate.toISOString() },
    totalLeads: total,
    closingStats: modelMetrics,
    outbox: jobStats || { sent: 0, pending: 0, failed: 0 },
  })
}
