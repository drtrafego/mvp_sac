export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { whatsappMessages, recoveryLeads } from '@/lib/db/schema'
import { eq, asc, and } from 'drizzle-orm'
import { sendWhatsAppMessage } from '@/lib/whatsapp'
import { sendInstagramMessage } from '@/lib/instagram'
import { sendBrevoEmail } from '@/lib/email/brevo'
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

  const messages = await db
    .select()
    .from(whatsappMessages)
    .where(and(eq(whatsappMessages.phone, lead.phone), eq(whatsappMessages.companyId, company.id)))
    .orderBy(asc(whatsappMessages.createdAt))
    .limit(300)

  return NextResponse.json({
    lead: {
      id: lead.id,
      phone: lead.phone,
      name: lead.name,
      email: lead.email,
      channel: lead.channel || 'whatsapp',
      platform: lead.platform,
      eventType: lead.eventType,
      status: lead.status,
      productName: lead.productName,
      productValue: lead.productValue,
      botPaused: lead.botPaused ?? false,
      botPausedAt: lead.botPausedAt,
      botPausedBy: lead.botPausedBy,
      trackingSource: lead.trackingSource,
      utmCampaign: lead.utmCampaign,
      createdAt: lead.createdAt,
    },
    messages: messages.map(m => ({
      id: m.id,
      phone: m.phone,
      channel: m.channel || 'whatsapp',
      direction: m.direction,
      content: m.content ?? null,
      messageType: m.messageType ?? 'text',
      mediaUrl: m.mediaUrl ?? null,
      sentBy: m.sentBy ?? 'human',
      createdAt: m.createdAt?.toISOString() ?? null,
    })),
  })
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { leadId } = await params
  const id = parseInt(leadId)
  if (isNaN(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const company = await requireCompany()

  const [lead] = await db
    .select()
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))

  if (!lead) return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 })

  const body = (await req.json()) as { content: string; messageType?: string; mediaUrl?: string }

  if (!body.content?.trim() && !body.mediaUrl) {
    return NextResponse.json({ error: 'Mensagem vazia' }, { status: 400 })
  }

  const channel = (lead.channel || 'whatsapp').toLowerCase()
  let externalId: string | null = null

  // 1. Roteamento de envio pelo canal apropriado
  if (channel === 'instagram' || lead.phone.startsWith('ig_')) {
    const igRes = await sendInstagramMessage({
      recipientId: lead.phone,
      text: body.content,
      mediaUrl: body.mediaUrl,
      companyId: company.id,
    })
    if (!igRes.ok) {
      console.warn('[Inbox Send Instagram Warning]:', igRes.error)
    }
    externalId = igRes.messageId ?? null
  } else if (channel === 'email' && lead.email) {
    const emailRes = await sendBrevoEmail({
      to: [{ email: lead.email, name: lead.name || undefined }],
      subject: `Re: Atendimento - ${lead.productName || 'SAC'}`,
      htmlContent: `<p>${body.content.replace(/\n/g, '<br/>')}</p>`,
      textContent: body.content,
      companyId: company.id,
    })
    if (!emailRes.ok) {
      console.warn('[Inbox Send Email Warning]:', emailRes.error)
    }
  } else {
    // WhatsApp (Meta Cloud API ou UazAPI)
    try {
      externalId = await sendWhatsAppMessage(
        lead.phone,
        {
          type: (body.messageType ?? 'text') as 'text' | 'image' | 'video' | 'audio' | 'document',
          content: body.content,
          mediaUrl: body.mediaUrl,
        },
        company.id
      )
    } catch (err) {
      console.error('[Inbox Send WhatsApp Error]:', err)
      // Ainda gravamos no banco como histórico local
    }
  }

  // 2. Gravar no banco de dados
  const [msg] = await db
    .insert(whatsappMessages)
    .values({
      companyId: company.id,
      leadId: lead.id,
      phone: lead.phone,
      channel: lead.channel || 'whatsapp',
      direction: 'outbound',
      content: body.content ?? null,
      messageType: body.messageType ?? 'text',
      mediaUrl: body.mediaUrl ?? null,
      sentBy: 'human',
      externalId,
    })
    .returning()

  // Atualizar data de modificação do lead
  await db
    .update(recoveryLeads)
    .set({ updatedAt: new Date() })
    .where(eq(recoveryLeads.id, lead.id))

  return NextResponse.json({
    id: msg.id,
    phone: msg.phone,
    channel: msg.channel,
    direction: msg.direction,
    content: msg.content,
    messageType: msg.messageType,
    mediaUrl: msg.mediaUrl,
    sentBy: msg.sentBy,
    createdAt: msg.createdAt?.toISOString() ?? null,
  })
}
