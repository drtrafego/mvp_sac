export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { authenticateAgentRequest } from '@/lib/agent-auth'
import { eq, and, asc, or, sql } from 'drizzle-orm'

type Params = { params: Promise<{ idOrSlug: string; leadId: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug, leadId } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  const id = parseInt(leadId)
  if (isNaN(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const [lead] = await db
    .select()
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, context.company.id)))

  if (!lead) return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 })

  const cleanPhone = (lead.phone || '').replace(/\D/g, '')
  const messages = await db
    .select()
    .from(whatsappMessages)
    .where(
      and(
        eq(whatsappMessages.companyId, context.company.id),
        or(
          eq(whatsappMessages.leadId, id),
          eq(whatsappMessages.phone, lead.phone),
          cleanPhone.length >= 9
            ? sql`right(regexp_replace(${whatsappMessages.phone}, '\\D', '', 'g'), 9) = right(${cleanPhone}, 9)`
            : undefined
        )
      )
    )
    .orderBy(asc(whatsappMessages.createdAt))
    .limit(300)

  return NextResponse.json({ ok: true, lead, messages })
}

export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug, leadId } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  const id = parseInt(leadId)
  if (isNaN(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  try {
    const body = await req.json()
    const updateData: Record<string, any> = { updatedAt: new Date() }

    if (body.name !== undefined) updateData.name = body.name
    if (body.email !== undefined) updateData.email = body.email
    if (body.phone !== undefined) updateData.phone = body.phone
    if (body.productName !== undefined) updateData.productName = body.productName
    if (body.productValue !== undefined) updateData.productValue = body.productValue
    if (body.status !== undefined) updateData.status = body.status
    if (body.stage !== undefined) updateData.pipelineStage = body.stage
    if (body.pipelineStage !== undefined) updateData.pipelineStage = body.pipelineStage
    if (body.botPaused !== undefined) updateData.botPaused = Boolean(body.botPaused)
    if (body.botPausedBy !== undefined) updateData.botPausedBy = body.botPausedBy
    if (body.botPaused !== undefined && body.botPaused) updateData.botPausedAt = new Date()

    if (body.followUpDate !== undefined) {
      updateData.followUpDate = body.followUpDate ? new Date(body.followUpDate) : null
    }
    if (body.followUpNote !== undefined) {
      updateData.followUpNote = body.followUpNote ? String(body.followUpNote).trim() : null
    }

    if (body.responsibleAgent !== undefined) {
      updateData.responsibleAgent = body.responsibleAgent
    } else if (context.agentName === 'Luana' || context.agentName === 'Renato') {
      updateData.responsibleAgent = context.agentName
    }

    updateData.lastActionBy = `${context.agentName} (Agente IA)`
    updateData.lastActionAt = new Date()

    const [updated] = await db
      .update(recoveryLeads)
      .set(updateData)
      .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, context.company.id)))
      .returning()

    if (!updated) return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 })

    // Log de auditoria da alteração
    const { logAgentActivity } = await import('@/lib/agent-auth')
    await logAgentActivity({
      companyId: context.company.id,
      agentName: context.agentName,
      agentId: context.agentId,
      action: body.pipelineStage || body.stage ? 'update_stage' : 'update_lead',
      entityType: 'lead',
      entityId: String(updated.id),
      details: {
        leadName: updated.name,
        newStage: updated.pipelineStage,
        followUpDate: updated.followUpDate,
        followUpNote: updated.followUpNote,
        dealValue: updated.productValue,
        responsibleAgent: updated.responsibleAgent,
      },
    })

    return NextResponse.json({ ok: true, lead: updated })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Erro ao atualizar lead' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug, leadId } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  const id = parseInt(leadId)
  if (isNaN(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  await db
    .delete(recoveryLeads)
    .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, context.company.id)))

  const { logAgentActivity } = await import('@/lib/agent-auth')
  await logAgentActivity({
    companyId: context.company.id,
    agentName: context.agentName,
    agentId: context.agentId,
    action: 'delete_lead',
    entityType: 'lead',
    entityId: String(id),
    details: { leadId: id },
  })

  return NextResponse.json({ ok: true, message: 'Lead excluído com sucesso' })
}
