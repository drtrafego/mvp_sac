export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads, companies } from '@/lib/db/schema'
import { eq, and, gte, lte, desc } from 'drizzle-orm'
import { dashboardLeadStatsSelect, resolveDashboardBusinessModel } from '@/lib/dashboard/lead-stats'
import { inferPipelineStage } from '@/lib/pipeline-stage'

// Verificacao TEMPORARIA, pos-rebase (fix proprio + PR#56 ja mergeado): prova
// que o CODIGO REAL final (dashboardLeadStatsSelect + inferPipelineStage, as
// mesmas funcoes que dashboard/pipeline usam em producao) devolve numeros
// corretos pra Isabela Fanini (company_id=2). So agregados. Chave por HEADER
// (x-verify-key). Remover esta rota e revogar OPS_VERIFY_DASHBOARD_CHECKOUT_KEY2
// assim que a verificacao terminar.

export async function GET(req: NextRequest) {
  const key = req.headers.get('x-verify-key')
  if (!key || key !== process.env.OPS_VERIFY_DASHBOARD_CHECKOUT_KEY2) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
  }

  const { searchParams } = new URL(req.url)
  const companyId = Number(searchParams.get('company_id') || '2')
  const from = searchParams.get('from') || '2026-09-01'
  const to = searchParams.get('to') || '2026-09-30'
  const fromDate = new Date(`${from}T00:00:00-03:00`)
  const toDate = new Date(`${to}T23:59:59.999-03:00`)

  const [companyRow] = await db.select().from(companies).where(eq(companies.id, companyId))
  if (!companyRow) return NextResponse.json({ ok: false, error: 'company_not_found' }, { status: 404 })

  const businessModel = resolveDashboardBusinessModel(companyRow.slug)

  const [leadStats] = await db
    .select(dashboardLeadStatsSelect(businessModel))
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.companyId, companyId), gte(recoveryLeads.createdAt, fromDate), lte(recoveryLeads.createdAt, toDate)))

  const periodLeads = await db
    .select()
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.companyId, companyId), gte(recoveryLeads.createdAt, fromDate), lte(recoveryLeads.createdAt, toDate)))

  const periodStageCounts: Record<string, number> = {}
  let periodFechadoCompraAprovada = 0
  for (const l of periodLeads) {
    const s = inferPipelineStage(l)
    periodStageCounts[s] = (periodStageCounts[s] ?? 0) + 1
    if (s === 'fechado' && l.eventType === 'compra_aprovada') periodFechadoCompraAprovada++
  }

  const allTimeLeads = await db
    .select()
    .from(recoveryLeads)
    .where(eq(recoveryLeads.companyId, companyId))
    .orderBy(desc(recoveryLeads.updatedAt))
    .limit(300)

  const allTimeStageCounts: Record<string, number> = {}
  let allTimeFechadoCompraAprovada = 0
  for (const l of allTimeLeads) {
    const s = inferPipelineStage(l)
    allTimeStageCounts[s] = (allTimeStageCounts[s] ?? 0) + 1
    if (s === 'fechado' && l.eventType === 'compra_aprovada') allTimeFechadoCompraAprovada++
  }

  return NextResponse.json({
    ok: true,
    company: { id: companyRow.id, slug: companyRow.slug, businessModel },
    period: { from, to },
    dashboardCards: {
      leadsTotais: leadStats?.total ?? 0,
      fechadosTotal: leadStats?.fechadosTotal ?? 0,
      boletoGerado: leadStats?.boleto ?? 0,
      pixGerado: leadStats?.pix ?? 0,
      carrinhoAbandonado: leadStats?.carrinho ?? 0,
      cartaoRecusado: leadStats?.cartao ?? 0,
      compraAprovada: leadStats?.aprovada ?? 0,
      aprovadaValueCents: Number(leadStats?.aprovadaValueCents ?? 0),
      recuperados: leadStats?.recoveredCount ?? 0,
      receitaRecuperadaCents: Number(leadStats?.recoveredValueCents ?? 0),
      vendasDiretasCount: leadStats?.directCount ?? 0,
      vendasDiretasCents: Number(leadStats?.directValueCents ?? 0),
    },
    pipelinePeriodo: {
      totalLeadsNoPeriodo: periodLeads.length,
      porEtapa: periodStageCounts,
      compraAprovadaEmFechado: periodFechadoCompraAprovada,
    },
    pipelineAllTime300: {
      totalLeadsLidos: allTimeLeads.length,
      porEtapa: allTimeStageCounts,
      compraAprovadaEmFechado: allTimeFechadoCompraAprovada,
    },
  })
}
