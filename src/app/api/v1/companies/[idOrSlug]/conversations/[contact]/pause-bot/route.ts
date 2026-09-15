export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { authenticateAgentRequest } from '@/lib/agent-auth'
import { eq, and, or, sql } from 'drizzle-orm'

type Params = { params: Promise<{ idOrSlug: string; contact: string }> }

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug, contact } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  const body = await req.json().catch(() => ({}))
  const pause = body.pause !== undefined ? Boolean(body.pause) : true
  const pausedBy = body.pausedBy || 'agent_api'

  const cleanPhone = contact.replace(/\D/g, '')
  const isLeadId = !isNaN(parseInt(contact)) && parseInt(contact) > 0

  const [updated] = await db
    .update(recoveryLeads)
    .set({
      botPaused: pause,
      botPausedAt: pause ? new Date() : null,
      botPausedBy: pause ? (body.pausedBy || `${context.agentName} (Agente IA)`) : null,
      lastActionBy: `${context.agentName} (Agente IA)`,
      lastActionAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(recoveryLeads.companyId, context.company.id),
        or(
          isLeadId ? eq(recoveryLeads.id, parseInt(contact)) : undefined,
          eq(recoveryLeads.phone, contact),
          cleanPhone.length >= 9
            ? sql`right(regexp_replace(${recoveryLeads.phone}, '\\D', '', 'g'), 9) = right(${cleanPhone}, 9)`
            : undefined
        )
      )
    )
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
