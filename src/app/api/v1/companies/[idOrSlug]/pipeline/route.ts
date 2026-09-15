export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { authenticateAgentRequest } from '@/lib/agent-auth'
import { eq, desc } from 'drizzle-orm'

type Params = { params: Promise<{ idOrSlug: string }> }

const DEFAULT_STAGES = [
  { id: 'novo_contato', label: 'Novo Contato' },
  { id: 'em_atendimento', label: 'Em Atendimento' },
  { id: 'qualificado', label: 'Qualificado' },
  { id: 'agendado', label: 'Agendado / Reserva' },
  { id: 'fechado', label: 'Fechado / Ganho' },
]

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  const leads = await db
    .select()
    .from(recoveryLeads)
    .where(eq(recoveryLeads.companyId, context.company.id))
    .orderBy(desc(recoveryLeads.updatedAt))
    .limit(300)

  // Agrupar por etapa
  const columns: Record<string, { stage: string; totalValue: number; count: number; leads: any[] }> = {}
  for (const s of DEFAULT_STAGES) {
    columns[s.id] = { stage: s.label, totalValue: 0, count: 0, leads: [] }
  }

  for (const l of leads) {
    const stageKey = l.pipelineStage || 'novo_contato'
    if (!columns[stageKey]) {
      columns[stageKey] = { stage: stageKey, totalValue: 0, count: 0, leads: [] }
    }
    columns[stageKey].leads.push(l)
    columns[stageKey].count++
    columns[stageKey].totalValue += (l.productValue || 0)
  }

  return NextResponse.json({
    ok: true,
    company: { id: context.company.id, slug: context.company.slug },
    totalLeads: leads.length,
    pipeline: columns,
  })
}
