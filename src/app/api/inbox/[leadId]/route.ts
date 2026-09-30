export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { whatsappMessages, recoveryLeads } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { sendWhatsAppMessage } from '@/lib/whatsapp'
import { sendInstagramMessage } from '@/lib/instagram'
import { sendBrevoEmail } from '@/lib/email/brevo'
import { requireCompany } from '@/lib/auth'
import { markLeadContacted } from '@/lib/leads'
import { getEmailEngagement } from '@/lib/email-engagement'
import {
  decodeMessageCursor,
  INBOX_MESSAGE_PAGE_SIZE,
  INBOX_MESSAGE_PAGE_SIZE_MAX,
  loadInboxMessagePage,
} from '@/lib/inbox-messages'
import { parseIntegerQuery } from '@/lib/request-validation'
import { resolveLeadDeliveryChannel } from '@/lib/lead-delivery-channel'

type Params = { params: Promise<{ leadId: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { leadId } = await params
  const id = parseInt(leadId)
  if (isNaN(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const { searchParams } = new URL(req.url)
  const parsedLimit = parseIntegerQuery(searchParams.get('limit'), {
    defaultValue: INBOX_MESSAGE_PAGE_SIZE,
    min: 1,
    max: INBOX_MESSAGE_PAGE_SIZE_MAX,
    label: 'limit',
  })
  if (!parsedLimit.ok) return NextResponse.json({ error: parsedLimit.error }, { status: 400 })

  const before = searchParams.get('before')
  if (before && !decodeMessageCursor(before)) {
    return NextResponse.json({ error: 'Cursor inválido.' }, { status: 400 })
  }

  const company = await requireCompany()

  const [lead] = await db
    .select()
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))

  if (!lead) return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 })

  const messagePage = await loadInboxMessagePage({
    companyId: company.id,
    leadId: id,
    phone: lead.phone,
    before,
    limit: parsedLimit.value,
  })
  const messages = messagePage.messages

  const lastInbound = [...messages].reverse().find(m => m.direction === 'inbound')
  const lastOutbound = [...messages].reverse().find(m => m.direction === 'outbound')
  const lastMsg = messages[messages.length - 1]

  return NextResponse.json({
    lead: {
      id: lead.id,
      phone: lead.phone,
      name: lead.name,
      email: lead.email,
      company: lead.company,
      notes: lead.notes,
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
      adsetName: lead.adsetName,
      adName: lead.adName,
      createdAt: lead.createdAt,
      firstContactAt: lead.firstContactAt,
      lastMessageAt: lastMsg?.createdAt?.toISOString() ?? null,
      lastInboundAt: lastInbound?.createdAt?.toISOString() ?? null,
      lastOutboundAt: lastOutbound?.createdAt?.toISOString() ?? null,
      agentDisplayName: company.agentDisplayName ?? null,
      emailEngagement: getEmailEngagement(lead.miningTags),
      agentConversationId: lead.agentConversationId,
      agentCostUsd: lead.agentCostUsd,
      agentInputTokens: lead.agentInputTokens,
      agentOutputTokens: lead.agentOutputTokens,
      agentSyncedAt: lead.agentSyncedAt?.toISOString() ?? null,
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
      reasoning: m.reasoning ?? null,
      sentEmail: m.sentEmail ?? null,
      createdAt: m.createdAt?.toISOString() ?? null,
    })),
    history: { hasMore: messagePage.hasMore, nextCursor: messagePage.nextCursor },
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

  const parsedBody: unknown = await req.json().catch(() => null)
  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return NextResponse.json({ error: 'O corpo da requisição deve ser um objeto JSON.' }, { status: 400 })
  }
  const body = parsedBody as Record<string, unknown>

  if (body.content != null && typeof body.content !== 'string') {
    return NextResponse.json({ error: 'O campo content deve ser um texto.' }, { status: 400 })
  }
  if (body.mediaUrl != null && typeof body.mediaUrl !== 'string') {
    return NextResponse.json({ error: 'O campo mediaUrl deve ser um texto.' }, { status: 400 })
  }
  if (body.messageType != null && typeof body.messageType !== 'string') {
    return NextResponse.json({ error: 'O campo messageType deve ser um texto.' }, { status: 400 })
  }

  const content = typeof body.content === 'string' ? body.content : ''
  const mediaUrl = typeof body.mediaUrl === 'string' ? body.mediaUrl : undefined
  const messageType = typeof body.messageType === 'string' ? body.messageType : undefined

  if (!content.trim() && !mediaUrl) {
    return NextResponse.json({ error: 'Mensagem vazia' }, { status: 400 })
  }

  const deliveryChannel = resolveLeadDeliveryChannel(lead)
  let externalId: string | null = null

  // 1. Roteamento de envio pelo canal apropriado
  if (deliveryChannel === 'instagram') {
    const igRes = await sendInstagramMessage({
      recipientId: lead.phone,
      text: content,
      mediaUrl,
      companyId: company.id,
    })
    if (!igRes.ok) {
      console.warn('[Inbox Send Instagram Warning]:', igRes.error)
    }
    externalId = igRes.messageId ?? null
  } else if (deliveryChannel === 'email' && lead.email) {
    const emailRes = await sendBrevoEmail({
      to: [{ email: lead.email, name: lead.name || undefined }],
      subject: `Re: Atendimento - ${lead.productName || 'SAC'}`,
      htmlContent: `<p>${content.replace(/\n/g, '<br/>')}</p>`,
      textContent: content,
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
          type: (messageType ?? 'text') as 'text' | 'image' | 'video' | 'audio' | 'document',
          content,
          mediaUrl,
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
      channel: deliveryChannel,
      direction: 'outbound',
      content: content || null,
      messageType: messageType ?? 'text',
      mediaUrl: mediaUrl ?? null,
      sentBy: 'human',
      externalId,
    })
    .returning()

  // Mensagem real trocada: se for a primeira, marca a abordagem do lead
  await markLeadContacted(lead.id)

  // Atualizar data de modificação e a última ação do lead. lastActionAt
  // precisa entrar junto: o COALESCE de ordenação do Inbox trava no
  // primeiro valor não nulo, então uma resposta manual do agente não subia
  // a conversa na lista quando lastActionAt já existia de antes.
  await db
    .update(recoveryLeads)
    .set({ updatedAt: new Date(), lastActionAt: new Date() })
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
