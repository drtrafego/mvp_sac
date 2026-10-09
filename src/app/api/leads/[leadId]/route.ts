import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { nullableDate, SacInputError } from '@/lib/sac-access'
import { followupDayToIso } from '@/lib/sac-followup-date'

type Params = { params: Promise<{ leadId: string }> }

export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { leadId } = await params
  const id = parseInt(leadId)
  if (isNaN(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const company = await requireCompany()

  const [lead] = await db
    .select()
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))

  if (!lead) return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 })

  return NextResponse.json(lead)
}

export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { leadId } = await params
  const id = parseInt(leadId)
  if (isNaN(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const company = await requireCompany()

  const body = await req.json()
  const updateData: Record<string, any> = {
    updatedAt: new Date(),
  }

  if (body.stage !== undefined) updateData.pipelineStage = body.stage
  if (body.pipelineStage !== undefined) updateData.pipelineStage = body.pipelineStage
  if (body.status !== undefined) updateData.status = body.status
  if (body.name !== undefined) updateData.name = body.name ? String(body.name).trim() : null
  if (body.email !== undefined) updateData.email = body.email ? String(body.email).trim() : null
  if (body.phone !== undefined) updateData.phone = String(body.phone).trim()
  if (body.productName !== undefined) updateData.productName = body.productName ? String(body.productName).trim() : null
  if (body.productValue !== undefined) {
    if (typeof body.productValue === 'number') {
      updateData.productValue = body.productValue
    } else if (typeof body.productValue === 'string') {
      const num = parseFloat(body.productValue.replace(/[^\d.,]/g, '').replace(',', '.'))
      updateData.productValue = isNaN(num) ? 0 : Math.round(num * 100)
    }
  }
  if (body.eventType !== undefined) updateData.eventType = String(body.eventType)
  if (body.paymentType !== undefined) updateData.paymentType = body.paymentType ? String(body.paymentType) : null
  if (body.platform !== undefined) updateData.platform = body.platform ? String(body.platform) : null
  if (body.trackingSource !== undefined) updateData.trackingSource = body.trackingSource ? String(body.trackingSource) : null
  if (body.utmMedium !== undefined) updateData.utmMedium = body.utmMedium ? String(body.utmMedium) : null
  if (body.notes !== undefined) updateData.notes = body.notes ? String(body.notes) : null

  try {
    for (const field of ['followUpDate', 'nextActionDueAt'] as const) {
      if (body[field] === undefined) continue
      const value = body[field]
      updateData[field] = nullableDate(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? followupDayToIso(value) : value, field)
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Prazo inválido' }, { status: error instanceof SacInputError ? error.status : 400 })
  }
  if (body.followUpNote !== undefined) {
    updateData.followUpNote = body.followUpNote ? String(body.followUpNote) : null
  }

  // SAC Context & Atendimento
  if (body.requestSummary !== undefined) updateData.requestSummary = body.requestSummary ? String(body.requestSummary) : null
  if (body.commitment !== undefined) updateData.commitment = body.commitment ? String(body.commitment) : null
  if (body.nextAction !== undefined) updateData.nextAction = body.nextAction ? String(body.nextAction) : null
  if (body.humanOwnerMemberId !== undefined) {
    updateData.humanOwnerMemberId = body.humanOwnerMemberId ? parseInt(body.humanOwnerMemberId) : null
  }
  if (body.sacCaseState !== undefined) {
    updateData.sacCaseState = body.sacCaseState ? String(body.sacCaseState) : 'aberto'
  }

  const [updated] = await db
    .update(recoveryLeads)
    .set(updateData)
    .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))
    .returning()

  if (!updated) {
    return NextResponse.json({ error: 'Lead não encontrado ou não pertence a esta empresa' }, { status: 404 })
  }

  return NextResponse.json({ ok: true, lead: updated })
}
