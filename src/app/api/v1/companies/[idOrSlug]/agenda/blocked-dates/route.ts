export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { agendaBlockedDates, settings } from '@/lib/db/schema'
import { authenticateAgentRequest, logAgentActivity } from '@/lib/agent-auth'
import { isUniqueViolation } from '@/lib/webhook-dedup'
import { DEFAULT_AVAILABILITY_SCHEDULE, isValidDate, type AvailabilitySchedule } from '@/lib/agenda-schedule'
import { maybeRefreshGoogleCalendarSync } from '@/lib/google-calendar-sync'
import { syncHermesAgendaBlockDate } from '@/lib/hermes-control-panel'
import { eq, and, asc, gte } from 'drizzle-orm'

type Params = { params: Promise<{ idOrSlug: string }> }

// O corte de "hoje" abaixo (GET) usa o timezone salvo em
// settings.availabilitySchedule.timezone quando existe; sem isso, cai em UTC do
// servidor. Hoje não tem consumidor real (nenhum bot lê essa rota ainda, é
// config pura), então o fallback UTC nunca gerou bug em produção, mas fica
// resolvido de origem pra quando a integração com o bot acontecer.
function resolveTodayInTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
      new Date()
    )
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

// Lista os bloqueios da empresa. Por padrão só os de hoje em diante (é o que
// importa para oferecer horário); ?all=1 traz o histórico completo.
export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  const showAll = req.nextUrl.searchParams.get('all') === '1'

  // Auto-refresh: mesma lógica de schedule/route.ts, ver comentário lá.
  await maybeRefreshGoogleCalendarSync({ id: context.company.id, slug: context.company.slug })

  const [settingsRow] = await db.select().from(settings).where(eq(settings.companyId, context.company.id))
  const timezone =
    (settingsRow?.availabilitySchedule as AvailabilitySchedule | null)?.timezone ?? DEFAULT_AVAILABILITY_SCHEDULE.timezone
  const today = resolveTodayInTimezone(timezone)

  const rows = await db
    .select()
    .from(agendaBlockedDates)
    .where(
      showAll
        ? eq(agendaBlockedDates.companyId, context.company.id)
        : and(eq(agendaBlockedDates.companyId, context.company.id), gte(agendaBlockedDates.date, today))
    )
    .orderBy(asc(agendaBlockedDates.date))

  return NextResponse.json({ ok: true, blockedDates: rows })
}

// Cria um bloqueio pontual (motivo opcional; segue o padrão do agenda_tools.py
// antigo, que preenche "bloqueado" quando o motivo vem vazio).
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  let date: unknown
  try {
    const body = await req.json().catch(() => ({}))
    ;({ date } = body)
    const { reason } = body

    if (!isValidDate(date)) {
      return NextResponse.json(
        { error: 'Data inválida. Use o formato AAAA-MM-DD.', code: 'INVALID_DATE' },
        { status: 400 }
      )
    }

    const cleanReason = typeof reason === 'string' && reason.trim() ? reason.trim() : 'bloqueado'

    const [existing] = await db
      .select()
      .from(agendaBlockedDates)
      .where(and(eq(agendaBlockedDates.companyId, context.company.id), eq(agendaBlockedDates.date, date)))

    if (existing) {
      return NextResponse.json(
        { error: `A data ${date} já está bloqueada.`, code: 'ALREADY_BLOCKED', blockedDate: existing },
        { status: 409 }
      )
    }

    const hermesSync = await syncHermesAgendaBlockDate(context.company.slug, date, cleanReason, true)
    if (!hermesSync.ok) {
      return NextResponse.json(
        {
          error: `Não salvei no SAC porque o Hermes não confirmou o bloqueio: ${hermesSync.error}`,
          code: 'HERMES_AGENDA_SYNC_FAILED',
        },
        { status: 502 }
      )
    }

    const [created] = await db
      .insert(agendaBlockedDates)
      .values({ companyId: context.company.id, date, reason: cleanReason })
      .returning()

    await logAgentActivity({
      companyId: context.company.id,
      agentName: context.agentName,
      agentId: context.agentId,
      action: 'agenda_block_date',
      entityType: 'settings',
      entityId: date,
      details: { date, reason: cleanReason },
    })

    return NextResponse.json({ ok: true, blockedDate: created }, { status: 201 })
  } catch (err) {
    // Duas requisições simultâneas bloqueando a mesma data passam as duas pelo
    // SELECT acima (nenhuma acha o registro ainda) e a segunda estoura o índice
    // único agenda_blocked_dates_company_date_unique no INSERT. isUniqueViolation
    // trata essa corrida como o mesmo 409 do caminho feliz, em vez de vazar o
    // erro cru do Postgres num 500.
    if (isUniqueViolation(err)) {
      return NextResponse.json(
        { error: `A data ${date} já está bloqueada.`, code: 'ALREADY_BLOCKED' },
        { status: 409 }
      )
    }
    const message = err instanceof Error ? err.message : 'Erro ao bloquear data'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
