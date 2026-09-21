export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { authenticateAgentRequest, logAgentActivity } from '@/lib/agent-auth'
import { eq, and, sql } from 'drizzle-orm'

type Params = { params: Promise<{ idOrSlug: string }> }

/**
 * POST /api/v1/companies/[idOrSlug]/pause-all
 * Pausa ou despausa o bot de IA para TODOS os leads da empresa de uma vez,
 * numa única query UPDATE (nunca um loop lead a lead).
 *
 * Body: { action: 'pause' | 'unpause', reason?: string }
 *
 * PAUSAR: afeta só quem ainda não estava pausado (bot_paused = false).
 * Quem já estava pausado individualmente por um humano (decisão própria antes
 * da ação em massa) permanece como estava, sem sobrescrever quem pausou.
 *
 * DESPAUSAR: reverte só quem esta MESMA ação em massa pausou (bot_paused_all
 * = true). Uma pausa individual feita por um humano por motivo próprio (ex.:
 * já está atendendo aquele cliente na mão) não é revertida por engano.
 */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  const body = await req.json().catch(() => ({}))
  const action = body.action === 'unpause' ? 'unpause' : 'pause'
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null

  // Ação de maior impacto do produto: pausar a empresa inteira não pode
  // acontecer com só duas palavras no body de uma chamada direta à API.
  // A UI (configuracoes/page.tsx) já tem o modal de confirmação client-side
  // e manda este campo; quem chamar por fora precisa mandar de propósito.
  if (action === 'pause' && body.confirm !== true) {
    return NextResponse.json(
      { error: 'Confirmação obrigatória: envie { "confirm": true } no body para pausar todo o atendimento.' },
      { status: 400 }
    )
  }

  const companyId = context.company.id
  const actionBy = `${context.agentName} (Agente IA)`
  const now = new Date()

  const updated = action === 'pause'
    ? await db
        .update(recoveryLeads)
        .set({
          botPaused: true,
          botPausedAt: now,
          botPausedBy: actionBy,
          botPausedAll: true,
          lastActionBy: actionBy,
          lastActionAt: now,
          updatedAt: now,
        })
        .where(and(eq(recoveryLeads.companyId, companyId), eq(recoveryLeads.botPaused, false)))
        .returning({ id: recoveryLeads.id })
    : await db
        .update(recoveryLeads)
        .set({
          botPaused: false,
          botPausedAt: null,
          botPausedBy: null,
          botPausedAll: false,
          lastActionBy: actionBy,
          lastActionAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(recoveryLeads.companyId, companyId),
            eq(recoveryLeads.botPaused, true),
            eq(recoveryLeads.botPausedAll, true)
          )
        )
        .returning({ id: recoveryLeads.id })

  await logAgentActivity({
    companyId,
    agentName: context.agentName,
    agentId: context.agentId,
    action: action === 'pause' ? 'pause_all' : 'unpause_all',
    entityType: 'company',
    entityId: String(companyId),
    details: { reason, affected: updated.length },
  })

  return NextResponse.json({
    ok: true,
    action,
    affected: updated.length,
    actionBy,
  })
}

/**
 * GET /api/v1/companies/[idOrSlug]/pause-all
 * Estado atual: quantos leads existem, quantos estão pausados no total, e
 * quantos foram pausados pela própria ação em massa (o que "despausar tudo"
 * de fato reverteria).
 */
export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  const companyId = context.company.id

  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      paused: sql<number>`count(*) filter (where ${recoveryLeads.botPaused})::int`,
      pausedByMassAction: sql<number>`count(*) filter (where ${recoveryLeads.botPaused} and ${recoveryLeads.botPausedAll})::int`,
    })
    .from(recoveryLeads)
    .where(eq(recoveryLeads.companyId, companyId))

  const total = counts?.total ?? 0
  const paused = counts?.paused ?? 0
  const pausedByMassAction = counts?.pausedByMassAction ?? 0

  return NextResponse.json({
    ok: true,
    total,
    paused,
    pausedByMassAction,
    pausedIndividually: paused - pausedByMassAction,
  })
}
