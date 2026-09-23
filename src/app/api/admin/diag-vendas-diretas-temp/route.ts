export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 30

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { companies, recoveryLeads } from '@/lib/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { dashboardLeadStatsSelect } from '@/lib/dashboard/lead-stats'

// Diagnóstico TEMPORÁRIO, uso único: provar contra produção que os dois
// cards novos do dashboard infoproduto/checkout ("Vendas Diretas" e "Receita
// Recuperada") somados batem com o total real de compra_aprovada da empresa,
// antes do merge da feature. Só devolve CONTAGENS e VALORES agregados
// (nunca telefone/nome/e-mail/conteúdo individual). Chave por HEADER
// (x-debug-token), nunca por query string. Remover esta rota e revogar
// DEBUG_REVENUE_TOKEN assim que a prova estiver confirmada.

export async function GET(req: NextRequest) {
  const token = req.headers.get('x-debug-token')
  if (!token || token !== process.env.DEBUG_REVENUE_TOKEN) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
  }

  const { searchParams } = new URL(req.url)
  const companyId = Number(searchParams.get('company_id') || '2')

  try {
    const [company] = await db
      .select({ id: companies.id, slug: companies.slug, name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId))

    // Mesma função usada pelo dashboard (dashboardLeadStatsSelect), sem
    // filtro de período: prova o dataset inteiro da empresa de uma vez.
    const [dashboardStats] = await db
      .select(dashboardLeadStatsSelect('infoproduto'))
      .from(recoveryLeads)
      .where(eq(recoveryLeads.companyId, companyId))

    // Verdade bruta e independente, fora de dashboardLeadStatsSelect: conta
    // e soma toda linha eventType='compra_aprovada' direto da tabela, sem
    // passar pela mesma função que estamos tentando provar.
    const [rawAprovada] = await db
      .select({
        count: sql<number>`cast(count(*) as int)`,
        valueCents: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}), 0) as bigint)`,
      })
      .from(recoveryLeads)
      .where(and(eq(recoveryLeads.companyId, companyId), eq(recoveryLeads.eventType, 'compra_aprovada')))

    const directValueCents = Number(dashboardStats?.directValueCents ?? 0)
    const recoveredValueCents = Number(dashboardStats?.recoveredValueCents ?? 0)
    const somaDiretaRecuperadaCents = directValueCents + recoveredValueCents
    const rawValueCents = Number(rawAprovada?.valueCents ?? 0)

    return NextResponse.json({
      ok: true,
      company,
      dashboardCards: {
        vendasDiretas: { count: dashboardStats?.directCount ?? 0, valueCents: directValueCents },
        receitaRecuperada: { count: dashboardStats?.recoveredCount ?? 0, valueCents: recoveredValueCents },
        somaDiretaRecuperadaCents,
      },
      totalAprovadaViaDashboardSelect: {
        count: dashboardStats?.aprovada ?? 0,
        valueCents: Number(dashboardStats?.aprovadaValueCents ?? 0),
      },
      totalAprovadaBruto: {
        count: rawAprovada?.count ?? 0,
        valueCents: rawValueCents,
      },
      bate: {
        valorSomaIgualBruto: somaDiretaRecuperadaCents === rawValueCents,
        diferencaCents: somaDiretaRecuperadaCents - rawValueCents,
      },
    })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
