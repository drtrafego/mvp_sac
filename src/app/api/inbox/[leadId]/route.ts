export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { whatsappMessages, recoveryLeads, sacAuditEvents, companyMembers } from '@/lib/db/schema'
import { eq, and, sql } from 'drizzle-orm'
import { sendWhatsAppMessage } from '@/lib/whatsapp'
import { sendInstagramMessage } from '@/lib/instagram'
import { sendBrevoEmail } from '@/lib/email/brevo'
import { sendOutboundForLead } from '@/lib/outbound-send'
import { requireCompany, requireSacActor, ForbiddenError, AuthError } from '@/lib/auth'
import { parseSacObject, parsePositiveId, parseExpectedVersion, validateSacContextFields, sacEpisodeForState, SacInputError } from '@/lib/sac-access'
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
function noStoreJson(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init)
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  response.headers.set('Pragma', 'no-cache')
  response.headers.set('Expires', '0')
  response.headers.set('Surrogate-Control', 'no-store')
  return response
}


type Params = { params: Promise<{ leadId: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { leadId } = await params
  const id = parseInt(leadId)
  if (isNaN(id)) return noStoreJson({ error: 'ID inválido' }, { status: 400 })

  const { searchParams } = new URL(req.url)
  const parsedLimit = parseIntegerQuery(searchParams.get('limit'), {
    defaultValue: INBOX_MESSAGE_PAGE_SIZE,
    min: 1,
    max: INBOX_MESSAGE_PAGE_SIZE_MAX,
    label: 'limit',
  })
  if (!parsedLimit.ok) return noStoreJson({ error: parsedLimit.error }, { status: 400 })

  const before = searchParams.get('before')
  if (before && !decodeMessageCursor(before)) {
    return noStoreJson({ error: 'Cursor inválido.' }, { status: 400 })
  }

  const company = await requireCompany()

  const [lead] = await db
    .select()
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))

  if (!lead) return noStoreJson({ error: 'Lead não encontrado' }, { status: 404 })

  const [humanOwner] = lead.humanOwnerMemberId ? await db.select({ name: companyMembers.name, userId: companyMembers.stackAuthUserId })
    .from(companyMembers)
    .where(and(eq(companyMembers.id, lead.humanOwnerMemberId), eq(companyMembers.companyId, company.id), eq(companyMembers.status, 'ativo')))
    .limit(1) : []

  const rawAroundMessageId = searchParams.get('aroundMessageId')
  const aroundMessageId = rawAroundMessageId ? parseInt(rawAroundMessageId) : null

  const messagePage = await loadInboxMessagePage({
    companyId: company.id,
    leadId: id,
    phone: lead.phone,
    before,
    limit: parsedLimit.value,
    aroundMessageId: aroundMessageId && !isNaN(aroundMessageId) ? aroundMessageId : null,
  })
  const messages = messagePage.messages

  const lastInbound = [...messages].reverse().find(m => m.direction === 'inbound')
  const lastOutbound = [...messages].reverse().find(m => m.direction === 'outbound' && (!m.sendState || m.sendState === 'accepted'))
  const lastMsg = messages[messages.length - 1]

  return noStoreJson({
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
      priority: lead.priority ?? null,
      productName: lead.productName,
      productValue: lead.productValue,
      botPaused: lead.botPaused ?? false,
      botPausedAt: lead.botPausedAt,
      botPausedBy: lead.botPausedBy,
      requestSummary: lead.requestSummary ?? null,
      requestMessageId: lead.requestMessageId ?? null,
      commitment: lead.commitment ?? null,
      nextAction: lead.nextAction ?? null,
      humanOwnerMemberId: lead.humanOwnerMemberId ?? null,
      humanOwnerName: humanOwner?.name ?? null,
      humanOwnerUserId: humanOwner?.userId ?? null,
      nextActionDueAt: lead.nextActionDueAt?.toISOString() ?? null,
      sacCaseState: lead.sacCaseState ?? null,
      pipelineStage: lead.pipelineStage ?? null,
      responsibleAgent: lead.responsibleAgent ?? null,
      followUpDate: lead.followUpDate?.toISOString() ?? null,
      followUpNote: lead.followUpNote ?? null,
      contextVersion: lead.contextVersion ?? 1,
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
      sendState: m.sendState ?? null,
      sendError: m.sendError ?? null,
      clientRequestId: m.clientRequestId ?? null,
      createdAt: m.createdAt?.toISOString() ?? null,
    })),
    history: { hasMore: messagePage.hasMore, nextCursor: messagePage.nextCursor },
  })
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { leadId } = await params
  const id = parseInt(leadId)
  if (isNaN(id)) return noStoreJson({ error: 'ID inválido' }, { status: 400 })

  const company = await requireCompany()

  const [lead] = await db
    .select()
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))

  if (!lead) return noStoreJson({ error: 'Lead não encontrado' }, { status: 404 })

  const parsedBody: unknown = await req.json().catch(() => null)
  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return noStoreJson({ error: 'O corpo da requisição deve ser um objeto JSON.' }, { status: 400 })
  }
  const body = parsedBody as Record<string, unknown>

  if (body.content != null && typeof body.content !== 'string') {
    return noStoreJson({ error: 'O campo content deve ser um texto.' }, { status: 400 })
  }
  if (body.mediaUrl != null && typeof body.mediaUrl !== 'string') {
    return noStoreJson({ error: 'O campo mediaUrl deve ser um texto.' }, { status: 400 })
  }
  if (body.messageType != null && typeof body.messageType !== 'string') {
    return noStoreJson({ error: 'O campo messageType deve ser um texto.' }, { status: 400 })
  }

  const content = typeof body.content === 'string' ? body.content : ''
  const mediaUrl = typeof body.mediaUrl === 'string' ? body.mediaUrl : undefined
  const messageType = typeof body.messageType === 'string' ? body.messageType : undefined
  const clientRequestId =
    (typeof body.clientRequestId === 'string' && body.clientRequestId.trim()) ||
    req.headers.get('x-client-request-id')?.trim() ||
    null

  if (!content.trim() && !mediaUrl) {
    return noStoreJson({ error: 'Mensagem vazia' }, { status: 400 })
  }

  const sendResult = await sendOutboundForLead({
    companyId: company.id,
    lead,
    content,
    mediaUrl,
    messageType,
    clientRequestId,
    sentBy: 'human',
  })

  if (!sendResult.ok) {
    return noStoreJson(
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
  return noStoreJson({
    id: msg.id,
    phone: msg.phone,
    channel: msg.channel,
    direction: msg.direction,
    content: msg.content,
    messageType: msg.messageType,
    mediaUrl: msg.mediaUrl,
    sentBy: msg.sentBy,
    sendState: msg.sendState,
    clientRequestId: msg.clientRequestId,
    createdAt: msg.createdAt?.toISOString() ?? null,
  })
}

export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const { leadId } = await params
    const id = parsePositiveId(leadId, 'Lead')
    const { company, actorId, actorName } = await requireSacActor()
    const body = parseSacObject(await req.json().catch(() => null))
    const expected = parseExpectedVersion(body.expectedContextVersion)
    const [lead] = await db.select().from(recoveryLeads)
      .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))
    if (!lead) return noStoreJson({ error: 'Lead não encontrado' }, { status: 404 })
    const fields = await validateSacContextFields(body, lead)
    const episode = typeof fields.sacCaseState === 'string' ? { sacCaseEpisode: sacEpisodeForState(fields.sacCaseState) } : {}
    if (Object.keys(fields).length === 0) return noStoreJson({ error: 'Nenhum campo alterado foi informado.' }, { status: 400 })
    const [updatedLead] = await db.update(recoveryLeads).set({
      ...fields, ...episode, updatedAt: new Date(), lastActionBy: actorName, lastActionAt: new Date(),
      contextVersion: sql`coalesce(${recoveryLeads.contextVersion}, 1) + 1`,
    }).where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id), sql`coalesce(${recoveryLeads.contextVersion}, 1) = ${expected}`)).returning()
    if (!updatedLead) return noStoreJson({ error: 'Outra pessoa alterou este atendimento. Atualize os dados antes de salvar.', code: 'CONTEXT_CONFLICT' }, { status: 409 })
    await db.insert(sacAuditEvents).values({ companyId: company.id, leadId: id, type: 'context_updated', actorType: 'human', actorId, actorName, payload: { updatedFields: Object.keys(fields), contextVersion: updatedLead.contextVersion } }).catch(() => { console.error('[SAC audit] context_updated not recorded', { companyId: company.id, leadId: id }) })
    return noStoreJson({ success: true, lead: updatedLead })
  } catch (err: unknown) {
    if (err instanceof SacInputError || err instanceof ForbiddenError || err instanceof AuthError) return noStoreJson({ error: err.message }, { status: err.status })
    return noStoreJson({ error: 'Erro ao atualizar atendimento.' }, { status: 500 })
  }
}
