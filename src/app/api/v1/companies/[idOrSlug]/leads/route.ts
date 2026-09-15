export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { authenticateAgentRequest } from '@/lib/agent-auth'
import { eq, and, desc, gte, lte, sql, ilike, or } from 'drizzle-orm'

type Params = { params: Promise<{ idOrSlug: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  const { searchParams } = new URL(req.url)
  const stage = searchParams.get('stage')
  const status = searchParams.get('status')
  const channel = searchParams.get('channel')
  const platform = searchParams.get('platform')
  const q = searchParams.get('q')?.trim()
  const limit = Math.min(parseInt(searchParams.get('limit') || '100'), 500)
  const offset = parseInt(searchParams.get('offset') || '0')

  const conditions = [eq(recoveryLeads.companyId, context.company.id)]
  if (stage) conditions.push(eq(recoveryLeads.pipelineStage, stage))
  if (status) conditions.push(eq(recoveryLeads.status, status))
  if (channel) conditions.push(eq(recoveryLeads.channel, channel))
  if (platform) conditions.push(eq(recoveryLeads.platform, platform))

  if (q) {
    conditions.push(
      or(
        ilike(recoveryLeads.name, `%${q}%`),
        ilike(recoveryLeads.phone, `%${q}%`),
        ilike(recoveryLeads.email, `%${q}%`),
        ilike(recoveryLeads.productName, `%${q}%`)
      )!
    )
  }

  const leads = await db
    .select()
    .from(recoveryLeads)
    .where(and(...conditions))
    .orderBy(desc(recoveryLeads.updatedAt))
    .limit(limit)
    .offset(offset)

  return NextResponse.json({
    ok: true,
    company: { id: context.company.id, slug: context.company.slug },
    count: leads.length,
    leads,
  })
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  try {
    const body = await req.json()
    const {
      name,
      phone,
      email,
      productName,
      productValue,
      eventType,
      platform,
      channel,
      status,
      stage,
      trackingSource,
      utmCampaign,
      followUpDate,
      followUpNote,
    } = body

    if (!phone) {
      return NextResponse.json({ error: 'Campo "phone" é obrigatório' }, { status: 400 })
    }

    const cleanPhone = String(phone).replace(/\D/g, '')

    const actingAgent = body.responsibleAgent || (context.agentName === 'Luana' || context.agentName === 'Renato' ? context.agentName : null)
    const actionBy = `${context.agentName} (Agente IA)`

    const [lead] = await db
      .insert(recoveryLeads)
      .values({
        companyId: context.company.id,
        name: name ? String(name).trim() : null,
        phone: cleanPhone || phone,
        email: email ? String(email).trim() : null,
        productName: productName || 'Geral',
        productValue: productValue ? Number(productValue) : null,
        eventType: eventType || 'contato_direto',
        platform: platform || 'sac',
        channel: channel || 'whatsapp',
        status: status || 'pending',
        pipelineStage: stage || 'novo_contato',
        trackingSource: trackingSource || 'agente_ia',
        utmCampaign: utmCampaign || null,
        followUpDate: followUpDate ? new Date(followUpDate) : null,
        followUpNote: followUpNote ? String(followUpNote).trim() : null,
        responsibleAgent: actingAgent,
        lastActionBy: actionBy,
        lastActionAt: new Date(),
      })
      .returning()

    // Registra log de auditoria do Agente (Luana / Renato)
    const { logAgentActivity } = await import('@/lib/agent-auth')
    await logAgentActivity({
      companyId: context.company.id,
      agentName: context.agentName,
      agentId: context.agentId,
      action: 'create_lead',
      entityType: 'lead',
      entityId: String(lead.id),
      details: {
        name: lead.name,
        phone: lead.phone,
        stage: lead.pipelineStage,
        origin: lead.trackingSource,
        responsibleAgent: actingAgent,
      },
    })

    return NextResponse.json({ ok: true, lead }, { status: 201 })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Erro ao criar lead' }, { status: 500 })
  }
}
