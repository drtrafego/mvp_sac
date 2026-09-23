export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads, companies } from '@/lib/db/schema'
import { eq, and, gte, lte, isNull } from 'drizzle-orm'
import { resolveDashboardBusinessModel } from '@/lib/dashboard/lead-stats'

// Verificacao TEMPORARIA, achado do @qa (revisao do PR#57): confirma que o
// card "Aguardando Abordagem" (dashboard + /origens) parou de contar venda
// ja aprovada de infoproduto como "nao abordada". So agregados. Chave por
// HEADER. Remover esta rota e revogar OPS_VERIFY_AWAITING_KEY depois.

export async function GET(req: NextRequest) {
  const key = req.headers.get('x-verify-key')
  if (!key || key !== process.env.OPS_VERIFY_AWAITING_KEY) {
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

  const baseWhere = and(eq(recoveryLeads.companyId, companyId), gte(recoveryLeads.createdAt, fromDate), lte(recoveryLeads.createdAt, toDate))

  // ANTES do fix (isNull puro, sem gate de businessModel) — pra provar que o
  // bug era real.
  const semFixRows = await db.select().from(recoveryLeads).where(and(baseWhere, isNull(recoveryLeads.firstContactAt)))
  const semFixCount = semFixRows.length

  // DEPOIS do fix: mesma logica de src/app/(dashboard)/page.tsx.
  const notContactedWhere = businessModel === 'infoproduto' ? undefined : and(baseWhere, isNull(recoveryLeads.firstContactAt))
  const depoisFixCount = notContactedWhere
    ? (await db.select().from(recoveryLeads).where(notContactedWhere)).length
    : 0

  return NextResponse.json({
    ok: true,
    company: { id: companyRow.id, slug: companyRow.slug, businessModel },
    period: { from, to },
    awaitingAbordagem: {
      semFix_bugReal: semFixCount,
      depoisDoFix: depoisFixCount,
    },
  })
}
