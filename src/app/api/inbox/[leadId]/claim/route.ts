export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads, sacAuditEvents } from '@/lib/db/schema'
import { eq, and, sql, or, isNull } from 'drizzle-orm'
import { requireSacActor, ForbiddenError, AuthError } from '@/lib/auth'
import { parseSacObject, parsePositiveId, parseExpectedVersion, sacEpisodeForState, SacInputError } from '@/lib/sac-access'

function noStoreJson(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init)
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  response.headers.set('Pragma', 'no-cache')
  response.headers.set('Expires', '0')
  return response
}

type Params = { params: Promise<{ leadId: string }> }

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const { leadId } = await params
    const id = parsePositiveId(leadId, 'Lead')
    const { company, memberId, actorId, actorName } = await requireSacActor()
    const body = parseSacObject(await req.json().catch(() => ({})))

    const [lead] = await db.select().from(recoveryLeads)
      .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))
    if (!lead) return noStoreJson({ error: 'Lead não encontrado' }, { status: 404 })
    const expected = body.expectedContextVersion === undefined
      ? (lead.contextVersion ?? 1)
      : parseExpectedVersion(body.expectedContextVersion)
    // Assumir é exclusivo: transferência para outro atendente é uma ação separada.
    const [updatedLead] = await db.update(recoveryLeads).set({
      humanOwnerMemberId: memberId,
      lastActionBy: actorName,
      lastActionAt: new Date(),
      botPaused: true,
      botPausedAt: new Date(),
      botPausedBy: actorName,
      botPausedAll: false,
      botPausedChannel: null,
      botControlVersion: sql`coalesce(${recoveryLeads.botControlVersion}, 1) + 1`,
      contextVersion: sql`coalesce(${recoveryLeads.contextVersion}, 1) + 1`,
      sacCaseState: lead.sacCaseState === 'resolvido' ? 'reaberto' : 'em_atendimento',
      sacCaseEpisode: sacEpisodeForState(lead.sacCaseState === 'resolvido' ? 'reaberto' : 'em_atendimento'),
      updatedAt: new Date(),
    }).where(and(
      eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id),
      sql`coalesce(${recoveryLeads.contextVersion}, 1) = ${expected}`,
      or(isNull(recoveryLeads.humanOwnerMemberId), eq(recoveryLeads.humanOwnerMemberId, memberId)),
    )).returning()
    if (!updatedLead) return noStoreJson({ error: 'O atendimento foi alterado ou assumido por outra pessoa. Atualize a conversa.', code: 'CONTEXT_CONFLICT' }, { status: 409 })
    const nextBotVersion = updatedLead.botControlVersion

    // Registrar evento de auditoria
    await db.insert(sacAuditEvents).values({
      companyId: company.id,
      leadId: id,
      type: 'assume_case',
      actorType: 'human',
      actorId,
      actorName,
      payload: {
        botControlVersion: nextBotVersion,
        previousOwner: lead.humanOwnerMemberId,
        newOwner: memberId,
      },
    }).catch(() => { console.error('[SAC audit] assume_case not recorded', { companyId: company.id, leadId: id }) })

    return noStoreJson({
      success: true,
      lead: { ...updatedLead, humanOwnerName: actorName, humanOwnerUserId: actorId },
      botControlVersion: nextBotVersion,
    })
  } catch (err: unknown) {
    if (err instanceof SacInputError || err instanceof ForbiddenError || err instanceof AuthError) return noStoreJson({ error: err.message }, { status: err.status })
    return noStoreJson({ error: 'Erro ao assumir atendimento' }, { status: 500 })
  }
}
