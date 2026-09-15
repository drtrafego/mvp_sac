import { NextRequest, NextResponse } from 'next/server'
import { getCurrentCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> }
) {
  try {
    const { leadId } = await params
    const id = parseInt(leadId)
    if (isNaN(id)) {
      return NextResponse.json({ error: 'ID de lead inválido' }, { status: 400 })
    }

    const company = await getCurrentCompany()
    if (!company) {
      return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })
    }

    const body = await req.json()
    const {
      name,
      phone,
      email,
      productName,
      productValue,
      trackingSource,
      stage,
      status,
      followUpDate,
      followUpNote,
      responsibleAgent,
    } = body

    const updateData: Record<string, any> = {
      updatedAt: new Date(),
    }

    if (name !== undefined) updateData.name = name ? String(name).trim() : null
    if (phone !== undefined) updateData.phone = String(phone).trim()
    if (email !== undefined) updateData.email = email ? String(email).trim() : null
    if (productName !== undefined) updateData.productName = productName ? String(productName).trim() : null
    if (productValue !== undefined) updateData.productValue = typeof productValue === 'number' ? Math.round(productValue) : null
    if (trackingSource !== undefined) updateData.trackingSource = trackingSource ? String(trackingSource).trim() : null
    if (stage !== undefined) updateData.pipelineStage = stage ? String(stage).trim() : 'novo_contato'
    if (status !== undefined) updateData.status = status ? String(status).trim() : null
    if (followUpDate !== undefined) updateData.followUpDate = followUpDate ? new Date(followUpDate) : null
    if (followUpNote !== undefined) updateData.followUpNote = followUpNote ? String(followUpNote).trim() : null
    if (responsibleAgent !== undefined) updateData.responsibleAgent = responsibleAgent ? String(responsibleAgent).trim() : null

    const [updated] = await db
      .update(recoveryLeads)
      .set(updateData)
      .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))
      .returning()

    if (!updated) {
      return NextResponse.json({ error: 'Lead não encontrado ou não pertence a esta empresa' }, { status: 404 })
    }

    return NextResponse.json({ success: true, lead: updated })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
