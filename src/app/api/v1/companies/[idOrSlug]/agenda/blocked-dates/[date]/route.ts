export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { agendaBlockedDates } from '@/lib/db/schema'
import { authenticateAgentRequest, logAgentActivity } from '@/lib/agent-auth'
import { isValidDate } from '@/lib/agenda-schedule'
import { shouldSyncHermesAgendaBlockRemoval, syncHermesAgendaBlockDate } from '@/lib/hermes-control-panel'
import { eq, and } from 'drizzle-orm'

type Params = { params: Promise<{ idOrSlug: string; date: string }> }

export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug, date } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  if (!isValidDate(date)) {
    return NextResponse.json({ error: 'Data inválida', code: 'INVALID_DATE' }, { status: 400 })
  }

  const [existing] = await db
    .select()
    .from(agendaBlockedDates)
    .where(and(eq(agendaBlockedDates.companyId, context.company.id), eq(agendaBlockedDates.date, date)))

  if (!existing) {
    return NextResponse.json({ error: `A data ${date} não estava bloqueada.` }, { status: 404 })
  }

  if (existing.source === 'google_calendar') {
    return NextResponse.json(
      {
        error: `A data ${date} veio do Google Calendar real. Remova o evento na agenda do Dr. Lucas e atualize a sincronização.`,
        code: 'GOOGLE_CALENDAR_BLOCK',
      },
      { status: 409 }
    )
  }

  if (shouldSyncHermesAgendaBlockRemoval(context.company.slug, existing.source)) {
    const hermesSync = await syncHermesAgendaBlockDate(context.company.slug, date, '', false)
    if (!hermesSync.ok) {
      return NextResponse.json(
        {
          error: `Não removi no SAC porque o Hermes não confirmou o desbloqueio: ${hermesSync.error}`,
          code: 'HERMES_AGENDA_SYNC_FAILED',
        },
        { status: 502 }
      )
    }
  }

  if (existing.source === 'google_calendar+bot_bloqueios') {
    const googleReason = existing.googleReason || existing.reason || null
    await db
      .update(agendaBlockedDates)
      .set({ source: 'google_calendar', botReason: null, reason: googleReason })
      .where(and(eq(agendaBlockedDates.companyId, context.company.id), eq(agendaBlockedDates.date, date)))

    await logAgentActivity({
      companyId: context.company.id,
      agentName: context.agentName,
      agentId: context.agentId,
      action: 'agenda_unblock_date',
      entityType: 'settings',
      entityId: date,
      details: { date, preservedSource: 'google_calendar' },
    })

    return NextResponse.json({ ok: true, message: `Bloqueio do bot removido; bloqueio do Google Calendar preservado em ${date}.` })
  }

  await db
    .delete(agendaBlockedDates)
    .where(and(eq(agendaBlockedDates.companyId, context.company.id), eq(agendaBlockedDates.date, date)))

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
