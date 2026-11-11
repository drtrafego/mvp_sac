export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { authenticateAgentRequest, logAgentActivity } from '@/lib/agent-auth'
import { eq, and, sql } from 'drizzle-orm'
import { getPauseSwitchMap, setPauseSwitch } from '@/lib/bot-pause'
import { syncGabiGlobalPause } from '@/lib/gabi-pause-mirror'

type Params = { params: Promise<{ idOrSlug: string }> }

const ALLOWED_CHANNELS = ['whatsapp', 'instagram', 'email'] as const
export type PauseChannelType = (typeof ALLOWED_CHANNELS)[number]

/**
 * POST /api/v1/companies/[idOrSlug]/pause-channel
 * Pausa ou despausa o bot de IA para todos os leads de um canal específico
 * (ex.: 'whatsapp' ou 'instagram') numa única query UPDATE em lote.
 *
 * Body: { action: 'pause' | 'unpause', channel: 'whatsapp' | 'instagram' | 'email', reason?: string, confirm?: boolean }
 *
 * PAUSAR: afeta só quem ainda não estava pausado no canal (channel = $ch AND bot_paused = false).
 * Quem já estava pausado individualmente por decisão humana permanece inalterado.
 *
 * DESPAUSAR: reverte só quem esta MESMA ação em massa pausou (channel = $ch AND bot_paused_channel = $ch).
 * Pausas individuais feitas por atendentes humanos nunca são desfeitas por engano.
 *
 * CHAVE PERSISTENTE (company_pause_switches, escopo = canal): pausar LIGA a
 * chave do canal antes de marcar os leads (leads novos e comentários
 * automáticos daquele canal nascem/ficam pausados); despausar DESLIGA antes de
 * liberar. Canal A pausado não afeta canal B.
 */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  const body = await req.json().catch(() => ({}))
  const channel = body.channel as PauseChannelType
  if (!channel || !ALLOWED_CHANNELS.includes(channel)) {
    return NextResponse.json(
      { error: `Canal inválido. Valores aceitos: ${ALLOWED_CHANNELS.join(', ')}.` },
      { status: 400 }
    )
  }

  const action = body.action === 'unpause' ? 'unpause' : 'pause'
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null

  if (action === 'pause' && body.confirm !== true) {
    return NextResponse.json(
      { error: `Confirmação obrigatória: envie { "confirm": true } no body para pausar o canal ${channel}.` },
      { status: 400 }
    )
  }

  const companyId = context.company.id
  const actionBy = `${context.agentName} (Agente IA)`
  const now = new Date()

  await setPauseSwitch({ companyId, scope: channel, active: action === 'pause', by: actionBy, reason })

  const updated =
    action === 'pause'
      ? await db
          .update(recoveryLeads)
          .set({
            botPaused: true,
            botPausedAt: now,
            botPausedBy: actionBy,
            botPausedChannel: channel,
            lastActionBy: actionBy,
            lastActionAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(recoveryLeads.companyId, companyId),
              eq(recoveryLeads.channel, channel),
              eq(recoveryLeads.botPaused, false)
            )
          )
          .returning({ id: recoveryLeads.id })
      : await db
          .update(recoveryLeads)
          .set({
            botPaused: false,
            botPausedAt: null,
            botPausedBy: null,
            botPausedChannel: null,
            lastActionBy: actionBy,
            lastActionAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(recoveryLeads.companyId, companyId),
              eq(recoveryLeads.channel, channel),
              eq(recoveryLeads.botPaused, true),
              eq(recoveryLeads.botPausedChannel, channel)
            )
          )
          .returning({ id: recoveryLeads.id })

  await logAgentActivity({
    companyId,
    agentName: context.agentName,
    agentId: context.agentId,
    action: action === 'pause' ? 'pause_channel' : 'unpause_channel',
    entityType: 'company',
    entityId: String(companyId),
    details: { channel, reason, affected: updated.length, scope: channel, switchActive: action === 'pause', actionBy },
  })

  // Gramado Plaza: só o canal whatsapp (e a pausa geral) alcança a Gabi; o
  // espelho lê as chaves e grava o estado resultante, então instagram/email
  // não a pausam nem a liberam por engano. Ver gabi-pause-mirror.ts.
  const gabi = channel === 'whatsapp' ? await syncGabiGlobalPause(context.company) : null

  return NextResponse.json({
    ok: true,
    action,
    channel,
    affected: updated.length,
    switchActive: action === 'pause',
    actionBy,
    ...(gabi && !gabi.skipped ? { gabi } : {}),
  })
}

/**
 * GET /api/v1/companies/[idOrSlug]/pause-channel
 * Retorna contagens por canal: total, ativos, pausados total e pausados por ação deste canal.
 */
export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  const companyId = context.company.id

  const rows = await db
    .select({
      channel: recoveryLeads.channel,
      total: sql<number>`count(*)::int`,
      paused: sql<number>`count(*) filter (where ${recoveryLeads.botPaused})::int`,
      pausedByChannel: sql<number>`count(*) filter (where ${recoveryLeads.botPaused} and ${recoveryLeads.botPausedChannel} = ${recoveryLeads.channel})::int`,
      pausedByGeneral: sql<number>`count(*) filter (where ${recoveryLeads.botPaused} and coalesce(${recoveryLeads.botPausedAll}, false))::int`,
      // Manual/outras: pausa de atendente, opt-out, anti-loop, tag. Não entra
      // aqui quem foi pausado pela ação do canal nem pela ação geral.
      pausedManual: sql<number>`count(*) filter (where ${recoveryLeads.botPaused} and not coalesce(${recoveryLeads.botPausedAll}, false) and ${recoveryLeads.botPausedChannel} is distinct from ${recoveryLeads.channel})::int`,
    })
    .from(recoveryLeads)
    .where(eq(recoveryLeads.companyId, companyId))
    .groupBy(recoveryLeads.channel)

  const switches = await getPauseSwitchMap(companyId)

  const channelMap: Record<
    string,
    {
      total: number
      active: number
      paused: number
      pausedByChannel: number
      pausedIndividually: number
      pausedByGeneral: number
      switchActive: boolean
      switchPausedAt: Date | null
      switchPausedBy: string | null
    }
  > = {}

  for (const ch of ALLOWED_CHANNELS) {
    channelMap[ch] = {
      total: 0, active: 0, paused: 0, pausedByChannel: 0, pausedIndividually: 0, pausedByGeneral: 0,
      switchActive: switches[ch].active, switchPausedAt: switches[ch].pausedAt, switchPausedBy: switches[ch].pausedBy,
    }
  }

  for (const r of rows) {
    const ch = (r.channel || '').toLowerCase()
    if (ALLOWED_CHANNELS.includes(ch as PauseChannelType)) {
      const total = r.total ?? 0
      const paused = r.paused ?? 0
      const pausedByChannel = r.pausedByChannel ?? 0
      channelMap[ch] = {
        ...channelMap[ch],
        total,
        active: total - paused,
        paused,
        pausedByChannel,
        // pausedIndividually = pausas manuais/outras (rótulo antigo
        // "paused - pausedByChannel" também contava quem a pausa GERAL pausou).
        pausedIndividually: r.pausedManual ?? 0,
        pausedByGeneral: r.pausedByGeneral ?? 0,
      }
    }
  }

  return NextResponse.json({
    ok: true,
    allSwitchActive: switches.all.active,
    channels: channelMap,
  })
}
