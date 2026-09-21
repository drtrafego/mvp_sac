export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { agendaBlockedDates } from '@/lib/db/schema'
import { authenticateAgentRequest, logAgentActivity } from '@/lib/agent-auth'
import { isValidDate } from '@/lib/agenda-schedule'
import { eq, and } from 'drizzle-orm'

type Params = { params: Promise<{ idOrSlug: string; date: string }> }

export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug, date } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  if (!isValidDate(date)) {
    return NextResponse.json({ error: 'Data inválida', code: 'INVALID_DATE' }, { status: 400 })
  }

  const [removed] = await db
    .delete(agendaBlockedDates)
    .where(and(eq(agendaBlockedDates.companyId, context.company.id), eq(agendaBlockedDates.date, date)))
    .returning()

  if (!removed) {
    return NextResponse.json({ error: `A data ${date} não estava bloqueada.` }, { status: 404 })
  }

  await logAgentActivity({
    companyId: context.company.id,
    agentName: context.agentName,
    agentId: context.agentId,
    action: 'agenda_unblock_date',
    entityType: 'settings',
    entityId: date,
    details: { date },
  })

  return NextResponse.json({ ok: true, message: `Data ${date} desbloqueada.` })
}
