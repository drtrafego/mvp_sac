import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'

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
  if (body.status !== undefined) updateData.status = body.status
  if (body.name !== undefined) updateData.name = body.name
  if (body.email !== undefined) updateData.email = body.email
  if (body.phone !== undefined) updateData.phone = body.phone

  if (body.followUpDate !== undefined) {
    updateData.followUpDate = body.followUpDate ? new Date(body.followUpDate) : null
  }
  if (body.followUpNote !== undefined) {
    updateData.followUpNote = body.followUpNote ? String(body.followUpNote) : null
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
