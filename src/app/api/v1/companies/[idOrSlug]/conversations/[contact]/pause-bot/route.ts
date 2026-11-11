export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { authenticateAgentRequest } from '@/lib/agent-auth'
import { eq, and, or, sql } from 'drizzle-orm'

import { resolveLeadForContact } from '@/lib/contact-resolution'
import { getBlockingPauseSwitch } from '@/lib/bot-pause'

type Params = { params: Promise<{ idOrSlug: string; contact: string }> }

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug, contact } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  let resolved
  try {
    resolved = await resolveLeadForContact(context.company.id, contact)
  } catch (err: unknown) {
    if (err instanceof Error && ['Contato é obrigatório.', 'leadId inválido: use lead:<id> com um inteiro positivo.'].includes(err.message)) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    throw err
  }

  if (resolved.ambiguous) {
    return NextResponse.json(
      { error: 'Contato ambíguo: informe o telefone completo em formato E.164 ou use lead:<id>.' },
      { status: 409 },
    )
  }

  if (!resolved.lead) {
    return NextResponse.json({ error: 'Contato não encontrado' }, { status: 404 })
  }

  const body = await req.json().catch(() => ({}))
  const pause =
    body.pause !== undefined
      ? Boolean(body.pause)
      : body.paused !== undefined
        ? Boolean(body.paused)
        : true

  // Chave de pausa da empresa/canal ligada: reativar um lead individual não
  // faria o bot responder (o envio continua barrado), então falha explícita.
  if (!pause) {
    const blockingSwitch = await getBlockingPauseSwitch(context.company.id, resolved.lead.channel)
    if (blockingSwitch) {
      return NextResponse.json(
        {
          error: 'A pausa da empresa está ligada para este canal. Desligue a chave (pause-all/pause-channel unpause) antes de reativar um lead individual.',
          switchScope: blockingSwitch.scope,
        },
        { status: 409 },
      )
    }
  }

  const [updated] = await db
    .update(recoveryLeads)
    .set({
      botPaused: pause,
      botPausedAt: pause ? new Date() : null,
      botPausedBy: pause ? (body.pausedBy || `${context.agentName} (Agente IA)`) : null,
      botControlVersion: sql`coalesce(${recoveryLeads.botControlVersion}, 0) + 1`,
      // Pausa/despausa individual sempre "reivindica" o lead: zera o flag da
      // ação em massa pra "Despausar Tudo" não reverter uma decisão humana
      // tomada depois do pause-all (ver pause-all/route.ts).
      botPausedAll: false,
      botPausedChannel: null,
      lastActionBy: `${context.agentName} (Agente IA)`,
      lastActionAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(recoveryLeads.id, resolved.lead.id))
    .returning()

  if (!updated) {
    return NextResponse.json({ error: 'Contato não encontrado' }, { status: 404 })
  }

  const { logAgentActivity } = await import('@/lib/agent-auth')
  await logAgentActivity({
    companyId: context.company.id,
    agentName: context.agentName,
    agentId: context.agentId,
    action: pause ? 'pause_bot' : 'resume_bot',
    entityType: 'lead',
    entityId: String(updated.id),
    details: {
      phone: updated.phone,
      reason: body.reason || null,
      source: 'api',
      previousBotPaused: resolved.lead.botPaused ?? false,
      actionBy: `${context.agentName} (Agente IA)`,
    },
  })

  return NextResponse.json({
    ok: true,
    botPaused: updated.botPaused,
    contact: updated.phone,
    leadId: updated.id,
    actionBy: `${context.agentName} (Agente IA)`,
  })
}
