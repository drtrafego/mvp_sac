export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { authenticateAgentRequest, logAgentActivity } from '@/lib/agent-auth'
import { syncGoogleCalendarBlockedDates } from '@/lib/google-calendar-sync'

type Params = { params: Promise<{ idOrSlug: string }> }

// Dispara a sync do Google Calendar do Dr. Lucas na hora, sem esperar os 5
// minutos do auto-refresh das rotas schedule/blocked-dates. Usada pelo botão
// "Atualizar agora" da tela e pela chamada única manual com ?backfill=1 que
// importa de uma vez tudo que já está bloqueado hoje (rodada logo após o
// deploy, pedido explícito do Gastão).
//
// Por enquanto só faz sentido pro Dr. Lucas (guard em isDrLucasCompany
// dentro de syncGoogleCalendarBlockedDates): chamada pra qualquer outra
// empresa devolve { ok: true, skipped: true, reason: 'not_drlucas' }, 200,
// nunca quebra a tela de ninguém.
export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  const backfill = req.nextUrl.searchParams.get('backfill') === '1'

  const result = await syncGoogleCalendarBlockedDates({ id: context.company.id, slug: context.company.slug })

  // google_sync_not_configured não é erro do cliente: a Service Account só
  // vai existir depois que o Gastão compartilhar os calendários com ela.
  // Devolve 200 com o motivo pra UI degradar bem em vez de mostrar erro.
  if (!result.ok && result.reason === 'google_sync_not_configured') {
    return NextResponse.json({ ok: true, skipped: true, reason: result.reason })
  }

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: result.errorMessage || 'Erro ao sincronizar com o Google Calendar.',
        reason: result.reason,
        calendars: result.calendars,
      },
      { status: 502 },
    )
  }

  if (!result.skipped) {
    await logAgentActivity({
      companyId: context.company.id,
      agentName: context.agentName,
      agentId: context.agentId,
      action: backfill ? 'agenda_google_calendar_backfill' : 'agenda_google_calendar_sync',
      entityType: 'settings',
      details: {
        eventsFound: result.eventsFound,
        created: result.created,
        updated: result.updated,
        skippedManual: result.skippedManual,
        calendars: result.calendars,
      },
    })
  }

  return NextResponse.json(result)
}
