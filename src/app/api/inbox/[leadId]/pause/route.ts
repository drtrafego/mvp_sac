export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireCompany, getCurrentUser } from '@/lib/auth'
import { logAgentActivity } from '@/lib/agent-auth'
import { getBlockingPauseSwitch } from '@/lib/bot-pause'

type Params = { params: Promise<{ leadId: string }> }

/**
 * POST /api/inbox/[leadId]/pause
 * Pausa ou despausa o bot de IA para o atendimento/lead específico.
 */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { leadId } = await params
  const id = parseInt(leadId)
  if (isNaN(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const company = await requireCompany()
  const user = await getCurrentUser()

  const [lead] = await db
    .select()
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))

  if (!lead) return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 })

  let body: { paused?: boolean } = {}
  try {
    body = await req.json()
  } catch {
    // se não passar body, inverte o estado atual
  }

  const nextPaused = typeof body.paused === 'boolean' ? body.paused : !lead.botPaused
  const operatorName = user?.displayName || user?.primaryEmail?.split('@')[0] || 'humano'

  // Com a chave de pausa da empresa/canal ligada, reativar UM lead não adianta
  // (o bot continuaria barrado no envio) e deixaria a tela mentindo. Falha
  // explícita em vez de "despausar" só no papel.
  if (!nextPaused) {
    const blockingSwitch = await getBlockingPauseSwitch(company.id, lead.channel)
    if (blockingSwitch) {
      return NextResponse.json(
        {
          error: 'A pausa da empresa está ligada para este canal. Reative em Configurações antes de liberar um lead individual.',
          switchScope: blockingSwitch.scope,
        },
        { status: 409 },
      )
    }
  }

  const [updated] = await db
    .update(recoveryLeads)
    .set({
      botPaused: nextPaused,
      botPausedAt: nextPaused ? new Date() : null,
      botPausedBy: nextPaused ? operatorName : null,
      // Pausa/despausa individual sempre "reivindica" o lead: zera o flag da
      // ação em massa pra "Despausar Tudo" não reverter uma decisão humana
      // tomada depois do pause-all (ver pause-all/route.ts).
      botPausedAll: false,
      botPausedChannel: null,
      updatedAt: new Date(),
    })
    .where(eq(recoveryLeads.id, id))
    .returning()

  await logAgentActivity({
    companyId: company.id,
    agentName: operatorName,
    action: nextPaused ? 'pause_bot' : 'resume_bot',
    entityType: 'lead',
    entityId: String(updated.id),
    details: { source: 'inbox', channel: lead.channel ?? null, previousBotPaused: lead.botPaused ?? false, actionBy: operatorName },
  })

  return NextResponse.json({
    ok: true,
    leadId: updated.id,
    botPaused: updated.botPaused,
    botPausedAt: updated.botPausedAt,
    botPausedBy: updated.botPausedBy,
  })
}
