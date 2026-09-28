export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { authenticateAgentRequest } from '@/lib/agent-auth'
import { sendWhatsAppMessage } from '@/lib/whatsapp'
import { sendInstagramMessage } from '@/lib/instagram'
import { sendBrevoEmail } from '@/lib/email/brevo'
import { eq, and, asc, or, sql } from 'drizzle-orm'
import { markLeadContacted } from '@/lib/leads'
import { type ContactIdentifier, parseContactIdentifier } from '@/lib/contact-resolution'

type Params = { params: Promise<{ idOrSlug: string; contact: string }> }
type ResolvedLeadForContact = {
  lead: typeof recoveryLeads.$inferSelect | undefined
  identifier: ContactIdentifier
  ambiguous: boolean
}

async function resolveLeadForContact(companyId: number, contact: string): Promise<ResolvedLeadForContact> {
  const identifier = parseContactIdentifier(contact)
  if (identifier.kind === 'leadId') {
    const [lead] = await db
      .select()
      .from(recoveryLeads)
      .where(and(eq(recoveryLeads.companyId, companyId), eq(recoveryLeads.id, identifier.leadId)))
      .limit(1)
    return { lead, identifier, ambiguous: false }
  }

  const exactMatches = await db
    .select()
    .from(recoveryLeads)
    .where(
      and(
        eq(recoveryLeads.companyId, companyId),
        or(
          eq(recoveryLeads.phone, identifier.raw),
          identifier.digits
            ? sql`regexp_replace(${recoveryLeads.phone}, '\\D', '', 'g') = ${identifier.digits}`
            : undefined
        )
      )
    )
    .limit(2)

  if (exactMatches.length === 1) return { lead: exactMatches[0], identifier, ambiguous: false }
  if (exactMatches.length > 1) return { lead: undefined, identifier, ambiguous: true }

  if (identifier.digits.length >= 9) {
    const suffixMatches = await db
      .select()
      .from(recoveryLeads)
      .where(
        and(
          eq(recoveryLeads.companyId, companyId),
          sql`right(regexp_replace(${recoveryLeads.phone}, '\\D', '', 'g'), 9) = right(${identifier.digits}, 9)`
        )
      )
      .limit(2)

    if (suffixMatches.length === 1) return { lead: suffixMatches[0], identifier, ambiguous: false }
    if (suffixMatches.length > 1) return { lead: undefined, identifier, ambiguous: true }
  }

  return { lead: undefined, identifier, ambiguous: false }
}

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
    const { content, messageType = 'text', mediaUrl, channel = 'whatsapp', sentBy = 'agent' } = body

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
          channel,
          status: 'in_conversation',
          eventType: 'api_outbound',
        })
        .returning()
      lead = newLead
    }

    let externalId: string | null = null

    // Disparo real conforme canal
    if (channel === 'instagram') {
      try {
        const igRes = await sendInstagramMessage({
          recipientId: lead.phone,
          text: content,
          companyId: context.company.id,
        })
        externalId = igRes.messageId || null
      } catch (igErr) {
        console.warn('[API Outbound Instagram Warning]:', igErr)
      }
    } else if (channel === 'email' && lead.email) {
      try {
        await sendBrevoEmail({
          to: [{ email: lead.email, name: lead.name || 'Cliente' }],
          subject: body.subject || 'Mensagem de Atendimento',
          htmlContent: `<p>${content.replace(/\n/g, '<br>')}</p>`,
          textContent: content,
          companyId: context.company.id,
        })
      } catch (emErr) {
        console.warn('[API Outbound Email Warning]:', emErr)
      }
    } else {
      // WhatsApp Meta / UazAPI
      try {
        externalId = await sendWhatsAppMessage(
          lead.phone,
          {
            type: messageType as any,
            content,
            mediaUrl,
          },
          context.company.id
        )
      } catch (waErr) {
        console.warn('[API Outbound WhatsApp Warning]:', waErr)
      }
    }

    // Registra no banco com autoria do agente (Luana / Renato)
    const senderDisplayName = body.senderName || context.agentName
    const [msg] = await db
      .insert(whatsappMessages)
      .values({
        companyId: context.company.id,
        leadId: lead.id,
        phone: lead.phone,
        channel,
        direction: 'outbound',
        content: content || null,
        messageType,
        mediaUrl: mediaUrl || null,
        sentBy: 'bot',
        senderName: senderDisplayName,
        agentId: context.agentId,
        externalId,
      })
      .returning()

    // Mensagem real trocada: se for a primeira, marca a abordagem do lead
    await markLeadContacted(lead.id)

    // Atualiza timestamp e última ação do lead
    await db
      .update(recoveryLeads)
      .set({
        lastActionBy: `${senderDisplayName} (Agente IA)`,
        lastActionAt: new Date(),
        updatedAt: new Date(),
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
        channel,
        phone: lead.phone,
        preview: (content || '').slice(0, 80),
      },
    })

    return NextResponse.json({
      ok: true,
      message: 'Mensagem enviada e registrada com sucesso',
      sentMessage: msg,
    }, { status: 201 })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Erro ao enviar mensagem' }, { status: 500 })
  }
}
