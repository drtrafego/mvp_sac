export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { whatsappMessages, recoveryLeads } from '@/lib/db/schema'
import { eq, asc, and, or, sql } from 'drizzle-orm'
import { sendWhatsAppMessage } from '@/lib/whatsapp'
import { sendInstagramMessage } from '@/lib/instagram'
import { sendBrevoEmail } from '@/lib/email/brevo'
import { requireCompany } from '@/lib/auth'
import { queryAgentsDb } from '@/lib/db/agents-db'

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

  let messages = await db
    .select()
    .from(whatsappMessages)
    .where(
      and(
        or(
          eq(whatsappMessages.leadId, id),
          eq(whatsappMessages.phone, lead.phone),
          sql`right(regexp_replace(${whatsappMessages.phone}, '\\D', '', 'g'), 9) = right(regexp_replace(${lead.phone}, '\\D', '', 'g'), 9)`
        ),
        eq(whatsappMessages.companyId, company.id)
      )
    )
    .orderBy(asc(whatsappMessages.createdAt))
    .limit(300)

  // Se não houver mensagens gravadas localmente, busca sob demanda no banco do Supabase/Agentes
  if (messages.length === 0) {
    try {
      const cleanPhone = lead.phone.replace(/\D/g, '')

      // 1. Busca em public.outreach_convos
      const convos = await queryAgentsDb<{ id: string; channel: string | null }>(`
        select id, channel from public.outreach_convos
        where right(regexp_replace(lead_handle, '\\D', '', 'g'), 9) = right($1, 9)
           or lead_handle = $2
        limit 1
      `, [cleanPhone, lead.phone])

      if (convos && convos.length > 0) {
        const convo = convos[0]
        const outreachMsgs = await queryAgentsDb<{
          id: string
          direction: string | null
          status: string | null
          subject: string | null
          body: string | null
          sent_at: string | null
        }>(`
          select id, direction, status, subject, body, sent_at
          from public.outreach_msgs
          where convo_id = $1
          order by sent_at asc
        `, [convo.id])

        if (outreachMsgs && outreachMsgs.length > 0) {
          for (const m of outreachMsgs) {
            const isUser = m.direction === 'inbound'
            const direction = isUser ? 'inbound' : 'outbound'
            const sentBy = isUser ? 'user' : 'bot'
            const externalId = `outreach_${m.id}`

            await db.insert(whatsappMessages).values({
              companyId: company.id,
              leadId: lead.id,
              phone: lead.phone,
              channel: lead.channel || convo.channel || 'whatsapp',
              direction,
              content: m.body || m.subject || '',
              messageType: 'text',
              sentBy,
              externalId,
              createdAt: m.sent_at ? new Date(m.sent_at) : new Date(),
            }).onConflictDoNothing()
          }
        }
      }

      // Re-consulta mensagens após sync sob demanda
      messages = await db
        .select()
        .from(whatsappMessages)
        .where(
          and(
            or(
              eq(whatsappMessages.leadId, id),
              eq(whatsappMessages.phone, lead.phone),
              sql`right(regexp_replace(${whatsappMessages.phone}, '\\D', '', 'g'), 9) = right(regexp_replace(${lead.phone}, '\\D', '', 'g'), 9)`
            ),
            eq(whatsappMessages.companyId, company.id)
          )
        )
        .orderBy(asc(whatsappMessages.createdAt))
        .limit(300)
    } catch {
      // Ignora erro de fallback silenciosamente
    }
  }

  const lastInbound = [...messages].reverse().find(m => m.direction === 'inbound')
  const lastOutbound = [...messages].reverse().find(m => m.direction === 'outbound')
  const lastMsg = messages[messages.length - 1]

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
      lastMessageAt: lastMsg?.createdAt?.toISOString() ?? null,
      lastInboundAt: lastInbound?.createdAt?.toISOString() ?? null,
      lastOutboundAt: lastOutbound?.createdAt?.toISOString() ?? null,
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
