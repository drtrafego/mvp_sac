export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { authenticateAgentRequest } from '@/lib/agent-auth'
import { sendWhatsAppMessage } from '@/lib/whatsapp'
import { sendInstagramMessage } from '@/lib/instagram'
import { sendBrevoEmail } from '@/lib/email/brevo'
import { sendOutboundForLead } from '@/lib/outbound-send'
import { eq, and, asc, or, sql } from 'drizzle-orm'
import { markLeadContacted } from '@/lib/leads'
import { type ContactIdentifier, parseContactIdentifier, resolveLeadForContact, type ResolvedLeadForContact } from '@/lib/contact-resolution'
import { resolveLeadDeliveryChannel } from '@/lib/lead-delivery-channel'

type Params = { params: Promise<{ idOrSlug: string; contact: string }> }


function contactIdentifierErrorResponse(err: unknown): NextResponse | null {
  if (!(err instanceof Error)) return null
  if (!['Contato é obrigatório.', 'leadId inválido: use lead:<id> com um inteiro positivo.'].includes(err.message)) {
    return null
  }
  return NextResponse.json({ error: err.message }, { status: 400 })
}

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug, contact } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  let resolved: ResolvedLeadForContact
  try {
    resolved = await resolveLeadForContact(context.company.id, contact)
  } catch (err) {
    const response = contactIdentifierErrorResponse(err)
    if (response) return response
    throw err
  }
  if (resolved.ambiguous) {
    return NextResponse.json({
      error: 'Contato ambíguo: informe o telefone completo em formato E.164 ou use lead:<id>.',
    }, { status: 409 })
  }

  let contactFilter
  if (resolved.lead) {
    contactFilter = eq(whatsappMessages.leadId, resolved.lead.id)
  } else {
    const identifier = resolved.identifier
    if (identifier.kind === 'phone') {
      contactFilter = or(
        eq(whatsappMessages.phone, identifier.raw),
        identifier.digits
          ? sql`regexp_replace(${whatsappMessages.phone}, '\\D', '', 'g') = ${identifier.digits}`
          : undefined
      )
    } else {
      contactFilter = eq(whatsappMessages.leadId, identifier.leadId)
    }
  }

  const messages = await db
    .select()
    .from(whatsappMessages)
    .where(
      and(
        eq(whatsappMessages.companyId, context.company.id),
        contactFilter
      )
    )
    .orderBy(asc(whatsappMessages.createdAt))
    .limit(300)

  return NextResponse.json({
    ok: true,
    contact,
    count: messages.length,
    messages,
  })
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug, contact } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  try {
    const body = await req.json()
    const { content, messageType = 'text', mediaUrl, channel: requestedChannel = 'whatsapp' } = body

    if (!content && !mediaUrl) {
      return NextResponse.json({ error: 'Conteúdo da mensagem ou mediaUrl é obrigatório' }, { status: 400 })
    }

    let resolved: ResolvedLeadForContact
    try {
      resolved = await resolveLeadForContact(context.company.id, contact)
    } catch (err) {
      const response = contactIdentifierErrorResponse(err)
      if (response) return response
      throw err
    }
    if (resolved.ambiguous) {
      return NextResponse.json({
        error: 'Contato ambíguo: informe o telefone completo em formato E.164 ou use lead:<id>.',
      }, { status: 409 })
    }

    // Encontra lead correspondente
    let lead = resolved.lead

    // Se lead não existir, auto-cria
    if (!lead) {
      const [newLead] = await db
        .insert(recoveryLeads)
        .values({
          companyId: context.company.id,
          phone: resolved.identifier.kind === 'phone'
            ? (resolved.identifier.digits || resolved.identifier.raw)
            : contact,
          name: `Contato ${contact.slice(-4)}`,
          channel: requestedChannel,
          status: 'in_conversation',
          eventType: 'api_outbound',
        })
        .returning()
      lead = newLead
    }

    // O canal informado pela API só inicializa um lead novo. Para leads
    // existentes (e após a criação), o próprio lead é a fonte única do
    // transporte; um override conflitante no body é deliberadamente ignorado.
    const senderDisplayName = body.senderName || context.agentName
    const clientRequestId =
      (typeof body.clientRequestId === 'string' && body.clientRequestId.trim()) ||
      req.headers.get('x-client-request-id')?.trim() ||
      null

    const sendResult = await sendOutboundForLead({
      companyId: context.company.id,
      lead,
      content,
      mediaUrl,
      messageType,
      clientRequestId,
      sentBy: 'bot',
      senderName: senderDisplayName,
      agentId: context.agentId,
      subject: body.subject || 'Mensagem de Atendimento',
    })

    if (!sendResult.ok) {
      return NextResponse.json(
        {
          error: sendResult.error || 'Falha no transporte de envio',
          isTimeout: sendResult.isTimeout,
          message: sendResult.message
            ? {
                id: sendResult.message.id,
                phone: sendResult.message.phone,
                channel: sendResult.message.channel,
                direction: sendResult.message.direction,
                content: sendResult.message.content,
                messageType: sendResult.message.messageType,
                mediaUrl: sendResult.message.mediaUrl,
                sentBy: sendResult.message.sentBy,
                senderName: sendResult.message.senderName,
                sendState: sendResult.message.sendState,
                sendError: sendResult.message.sendError,
                clientRequestId: sendResult.message.clientRequestId,
                createdAt: sendResult.message.createdAt?.toISOString() ?? null,
              }
            : null,
        },
        { status: sendResult.status },
      )
    }

    const msg = sendResult.message!

    // Atualiza lastActionBy do agente no lead
    await db
      .update(recoveryLeads)
      .set({
        lastActionBy: `${senderDisplayName} (Agente IA)`,
      })
      .where(eq(recoveryLeads.id, lead.id))

    // Log de auditoria
    const { logAgentActivity } = await import('@/lib/agent-auth')
    await logAgentActivity({
      companyId: context.company.id,
      agentName: senderDisplayName,
      agentId: context.agentId,
      action: 'send_message',
      entityType: 'message',
      entityId: String(msg.id),
      details: {
        leadId: lead.id,
        channel: msg.channel,
        phone: lead.phone,
        preview: (content || '').slice(0, 80),
      },
    })

    return NextResponse.json({
      ok: true,
      message: 'Mensagem enviada e registrada com sucesso',
      sentMessage: msg,
    }, { status: 201 })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erro ao enviar mensagem'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
