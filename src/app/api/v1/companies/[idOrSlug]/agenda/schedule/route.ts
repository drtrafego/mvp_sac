export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { authenticateAgentRequest, logAgentActivity } from '@/lib/agent-auth'
import { eq } from 'drizzle-orm'
import { DEFAULT_AVAILABILITY_SCHEDULE, validateAvailabilitySchedule, type AvailabilitySchedule } from '@/lib/agenda-schedule'
import { isNativeAvailabilityCompany } from '@/lib/agenda-schedule'
import { maybeRefreshGoogleCalendarSync } from '@/lib/google-calendar-sync'
import { getNativeAvailabilitySnapshot } from '@/lib/native-availability'

type Params = { params: Promise<{ idOrSlug: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  // Auto-refresh: se a última confirmação do Google Calendar tem mais de 5
  // minutos (ou nunca rodou), sincroniza antes de responder. Não-fatal: uma
  // falha de rede/credencial aqui nunca quebra esta tela (ver
  // maybeRefreshGoogleCalendarSync). Sem efeito pra qualquer empresa que não
  // seja o Dr. Lucas.
  await maybeRefreshGoogleCalendarSync({ id: context.company.id, slug: context.company.slug })

  if (isNativeAvailabilityCompany(context.company.slug)) {
    const snapshot = await getNativeAvailabilitySnapshot(context.company.id)
    if (!snapshot) {
      return NextResponse.json({
        ok: false,
        readOnly: true,
        sourceStatus: 'unavailable',
        error: 'O horário real do bot ainda não foi sincronizado.',
      }, { status: 503 })
    }
    return NextResponse.json({
      ok: true,
      readOnly: true,
      sourceStatus: 'synced',
      schedule: snapshot.schedule,
      source: snapshot.source,
      sourceLabel: snapshot.sourceLabel,
      sourceCursor: snapshot.sourceCursor,
      capturedAt: snapshot.capturedAt.toISOString(),
      syncedAt: snapshot.syncedAt.toISOString(),
    })
  }

  const [row] = await db.select().from(settings).where(eq(settings.companyId, context.company.id))
  const schedule = (row?.availabilitySchedule as AvailabilitySchedule | null) ?? DEFAULT_AVAILABILITY_SCHEDULE

  return NextResponse.json({ ok: true, readOnly: false, sourceStatus: 'manual', schedule })
}

export async function PUT(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  if (isNativeAvailabilityCompany(context.company.slug)) {
    return NextResponse.json({
      error: 'Horário somente leitura. Altere a configuração nativa do bot; o SAC apenas espelha o valor real.',
      readOnly: true,
    }, { status: 409 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const result = validateAvailabilitySchedule(body)
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    const [existing] = await db.select().from(settings).where(eq(settings.companyId, context.company.id))

    if (existing) {
      await db
        .update(settings)
        .set({ availabilitySchedule: result.schedule, updatedAt: new Date() })
        .where(eq(settings.id, existing.id))
    } else {
      await db.insert(settings).values({ companyId: context.company.id, availabilitySchedule: result.schedule })
    }

    await logAgentActivity({
      companyId: context.company.id,
      agentName: context.agentName,
      agentId: context.agentId,
      action: 'agenda_update_schedule',
      entityType: 'settings',
      details: result.schedule,
    })

    return NextResponse.json({ ok: true, schedule: result.schedule })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro ao atualizar a grade de horários'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
