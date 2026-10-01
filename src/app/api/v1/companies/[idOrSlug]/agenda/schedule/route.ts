export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { authenticateAgentRequest, logAgentActivity } from '@/lib/agent-auth'
import { eq } from 'drizzle-orm'
import { DEFAULT_AVAILABILITY_SCHEDULE, isNativeAvailabilityCompany, normalizeAvailabilitySchedule, validateAvailabilitySchedule } from '@/lib/agenda-schedule'
import { maybeRefreshGoogleCalendarSync } from '@/lib/google-calendar-sync'
import { getNativeAvailabilitySnapshot } from '@/lib/native-availability'
import { restoreHermesAgendaConfig, shouldSyncHermesAgenda, syncHermesAgendaSchedule } from '@/lib/hermes-control-panel'

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

  const [row] = await db.select().from(settings).where(eq(settings.companyId, context.company.id))
  const storedSchedule = normalizeAvailabilitySchedule(row?.availabilitySchedule)
  const nativeCompany = isNativeAvailabilityCompany(context.company.slug)
  // Um override manual só pode vencer o espelho nativo quando existe escrita
  // confirmada de volta na fonte operacional. Gramado ainda lê a grade da API
  // de reservas, que não oferece endpoint de configuração; portanto um valor
  // salvo apenas no SAC seria uma divergência perigosa e deve ser ignorado.
  const nativeWriteEnabled = nativeCompany && shouldSyncHermesAgenda(context.company.slug)
  const scheduleReadOnly = nativeCompany && !nativeWriteEnabled
  const manualOverride = !scheduleReadOnly && (Boolean(row?.availabilityScheduleManual) || !nativeCompany)
  const nativeSnapshot = manualOverride ? null : await getNativeAvailabilitySnapshot(context.company.id)
  const schedule = (manualOverride ? storedSchedule : null) ?? nativeSnapshot?.schedule ?? storedSchedule ?? DEFAULT_AVAILABILITY_SCHEDULE

  return NextResponse.json({
    ok: true,
    readOnly: scheduleReadOnly,
    sourceStatus: manualOverride && storedSchedule ? 'manual' : nativeSnapshot ? 'native_snapshot_imported' : 'default',
    schedule,
    source: nativeSnapshot?.source,
    sourceLabel: nativeSnapshot?.sourceLabel,
    sourceCursor: nativeSnapshot?.sourceCursor,
    capturedAt: nativeSnapshot?.capturedAt.toISOString(),
    syncedAt: nativeSnapshot?.syncedAt.toISOString(),
  })
}

export async function PUT(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  try {
    if (isNativeAvailabilityCompany(context.company.slug) && !shouldSyncHermesAgenda(context.company.slug)) {
      return NextResponse.json(
        {
          error: 'Este horário vem da fonte operacional do bot e ainda não possui uma API de escrita segura.',
          code: 'NATIVE_AGENDA_WRITE_UNAVAILABLE',
          readOnly: true,
        },
        { status: 409 },
      )
    }

    const body = await req.json().catch(() => ({}))
    const result = validateAvailabilitySchedule(body)
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    // Leia antes de tocar a fonte externa. Além de evitar uma escrita remota
    // quando o banco já está indisponível, este estado é o alvo da persistência.
    const [existing] = await db.select().from(settings).where(eq(settings.companyId, context.company.id))

    const hermesSync = await syncHermesAgendaSchedule(context.company.slug, result.schedule)
    if (!hermesSync.ok) {
      return NextResponse.json(
        {
          error: `Não salvei no SAC porque o Hermes não confirmou a nova agenda: ${hermesSync.error}`,
          code: 'HERMES_AGENDA_SYNC_FAILED',
        },
        { status: 502 },
      )
    }

    try {
      if (existing) {
        await db
          .update(settings)
          .set({ availabilitySchedule: result.schedule, availabilityScheduleManual: true, updatedAt: new Date() })
          .where(eq(settings.id, existing.id))
      } else {
        await db.insert(settings).values({ companyId: context.company.id, availabilitySchedule: result.schedule, availabilityScheduleManual: true })
      }
    } catch (dbError) {
      const previousConfig = hermesSync.data.previousConfig
      const rollback = previousConfig
        ? await restoreHermesAgendaConfig(context.company.slug, previousConfig)
        : { ok: true as const }
      const detail = dbError instanceof Error ? dbError.message : 'falha ao persistir no banco'
      return NextResponse.json(
        {
          error: rollback.ok
            ? `Não salvei no SAC; a alteração no Hermes foi revertida: ${detail}`
            : `Não salvei no SAC e não consegui reverter o Hermes: ${detail}. ${rollback.error}`,
          code: rollback.ok ? 'SAC_AGENDA_SAVE_FAILED_ROLLED_BACK' : 'SAC_AGENDA_SAVE_FAILED_ROLLBACK_FAILED',
        },
        { status: 500 },
      )
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
