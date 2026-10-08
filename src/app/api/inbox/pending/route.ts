export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sacPendingItems, recoveryLeads } from '@/lib/db/schema'
import { eq, and, desc } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { evaluateSacPendingRules } from '@/lib/sac-pending-rules'

function noStoreJson(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init)
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  response.headers.set('Pragma', 'no-cache')
  response.headers.set('Expires', '0')
  return response
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const company = await requireCompany()

    const { searchParams } = new URL(req.url)
    const state = searchParams.get('state') || 'pendente'

    // Opcionalmente reavalia regras antes de listar
    await evaluateSacPendingRules({ companyId: company.id }).catch(() => null)

    const conditions = [eq(sacPendingItems.companyId, company.id)]
    if (state !== 'all') {
      conditions.push(eq(sacPendingItems.state, state))
    }

    const items = await db
      .select({
        id: sacPendingItems.id,
        leadId: sacPendingItems.leadId,
        ruleType: sacPendingItems.ruleType,
        reason: sacPendingItems.reason,
        humanOwnerMemberId: sacPendingItems.humanOwnerMemberId,
        dueAt: sacPendingItems.dueAt,
        state: sacPendingItems.state,
        createdAt: sacPendingItems.createdAt,
        leadName: recoveryLeads.name,
        leadPhone: recoveryLeads.phone,
        leadStage: recoveryLeads.pipelineStage,
        leadStatus: recoveryLeads.status,
      })
      .from(sacPendingItems)
      .innerJoin(recoveryLeads, eq(sacPendingItems.leadId, recoveryLeads.id))
      .where(and(...conditions))
      .orderBy(desc(sacPendingItems.createdAt))
      .limit(50)

    return noStoreJson({
      items: items.map((i) => ({
        ...i,
        dueAt: i.dueAt?.toISOString() ?? null,
        createdAt: i.createdAt?.toISOString() ?? null,
      })),
    })
  } catch (err: any) {
    return noStoreJson({ error: err.message || 'Erro ao carregar pendências' }, { status: 500 })
  }
}
