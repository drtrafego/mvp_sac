export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads, sacAuditEvents, companyMembers } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'

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
    const id = parseInt(leadId)
    if (isNaN(id)) return noStoreJson({ error: 'ID inválido' }, { status: 400 })

    const company = await requireCompany()

    const [lead] = await db
      .select()
      .from(recoveryLeads)
      .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))

    if (!lead) return noStoreJson({ error: 'Lead não encontrado' }, { status: 404 })

    const body = (await req.json().catch(() => ({}))) as Record<string, any>
    const memberId = body.memberId ? String(body.memberId).trim() : null
    const memberName = body.memberName ? String(body.memberName).trim() : 'Atendente Humano'

    const parsedMemberId = memberId && !isNaN(parseInt(memberId)) ? parseInt(memberId) : null

    // Se memberId foi fornecido, validar se pertence à mesma empresa
    if (parsedMemberId) {
      const [member] = await db
        .select()
        .from(companyMembers)
        .where(and(eq(companyMembers.id, parsedMemberId), eq(companyMembers.companyId, company.id)))

      if (!member) {
        return noStoreJson({ error: 'Membro informado não pertence a esta empresa' }, { status: 403 })
      }
    }

    const nextBotVersion = (lead.botControlVersion || 1) + 1
    const nextContextVersion = (lead.contextVersion || 1) + 1

    const [updatedLead] = await db
      .update(recoveryLeads)
      .set({
        humanOwnerMemberId: parsedMemberId,
        lastActionBy: memberName,
        lastActionAt: new Date(),
        botPaused: true,
        botPausedAt: new Date(),
        botPausedBy: memberName,
        botControlVersion: nextBotVersion,
        contextVersion: nextContextVersion,
        sacCaseState: lead.sacCaseState === 'resolvido' ? 'reaberto' : 'em_atendimento',
        updatedAt: new Date(),
      })
      .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))
      .returning()

    // Registrar evento de auditoria
    await db.insert(sacAuditEvents).values({
      companyId: company.id,
      leadId: id,
      type: 'assume_case',
      actorType: 'human',
      actorId: memberId,
      actorName: memberName,
      payload: {
        botControlVersion: nextBotVersion,
        previousOwner: lead.humanOwnerMemberId,
        newOwner: memberId,
      },
    }).catch(() => null)

    return noStoreJson({
      success: true,
      lead: updatedLead,
      botControlVersion: nextBotVersion,
    })
  } catch (err: any) {
    return noStoreJson({ error: err.message || 'Erro ao assumir atendimento' }, { status: 500 })
  }
}
