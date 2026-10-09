import { notFound } from 'next/navigation'
import { and, desc, eq, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { appointmentMirror, companyMembers, gramadoReservations, recoveryLeads } from '@/lib/db/schema'
import { requireCompany } from '@/lib/auth'
import { getEmailEngagement } from '@/lib/email-engagement'
import { loadInboxMessagePage } from '@/lib/inbox-messages'
import { isInstagramDelivery } from '@/lib/lead-delivery-channel'
import { ChatWindow } from '@/components/inbox/ChatWindow'
import { attentionConversationNavigation } from '@/lib/sac-attention-navigation'

interface ConversationChatPageProps {
  leadId: string
  backHref: '/inbox' | '/instagram'
  requiredChannel?: 'instagram'
  searchParams?: Promise<Record<string, string | string[] | undefined>> | Record<string, string | string[] | undefined>
}

/**
 * Implementação única da tela de conversa, compartilhada pelo Inbox geral e
 * pela área de Instagram Direct. A rota dedicada só acrescenta o gate de
 * canal e a navegação de volta; histórico, envio e detalhes continuam iguais.
 */
export async function ConversationChatPage({
  leadId,
  backHref,
  requiredChannel,
  searchParams,
}: ConversationChatPageProps) {
  const id = Number.parseInt(leadId, 10)
  if (Number.isNaN(id)) notFound()

  const sParams = searchParams ? await searchParams : {}
  const navigation = attentionConversationNavigation(sParams, backHref)
  const rawAround = Array.isArray(sParams.aroundMessageId) ? sParams.aroundMessageId[0] : sParams.aroundMessageId
  const parsedAround = rawAround && /^\d+$/.test(rawAround) ? Number(rawAround) : null
  const validAround = parsedAround && Number.isSafeInteger(parsedAround) && parsedAround > 0 ? parsedAround : null

  const company = await requireCompany()
  const [lead] = await db
    .select()
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))

  if (!lead) notFound()
  if (requiredChannel === 'instagram' && !isInstagramDelivery(lead)) notFound()

  const cleanPhone = (lead.phone || '').replace(/\D/g, '')
  const last9 = cleanPhone.length >= 9 ? cleanPhone.slice(-9) : cleanPhone

  const [messagePage, appointments, reservations, ownerRows] = await Promise.all([
    loadInboxMessagePage({
      companyId: company.id,
      leadId: id,
      phone: lead.phone,
      aroundMessageId: validAround,
    }),
    cleanPhone
      ? db
          .select({
            nativeId: appointmentMirror.nativeId,
            consultationAt: appointmentMirror.consultationAt,
            status: appointmentMirror.status,
            origin: appointmentMirror.origin,
            cancelledAt: appointmentMirror.cancelledAt,
          })
          .from(appointmentMirror)
          .where(
            and(
              eq(appointmentMirror.companyId, company.id),
              sql`right(${appointmentMirror.phoneNorm}, 9) = ${last9}`,
            ),
          )
          .orderBy(desc(appointmentMirror.consultationAt))
          .limit(20)
      : Promise.resolve([]),
    db
      .select()
      .from(gramadoReservations)
      .where(and(
        eq(gramadoReservations.companyId, company.id),
        or(
          eq(gramadoReservations.leadId, id),
          cleanPhone
            ? sql`right(${gramadoReservations.phoneNorm}, 9) = right(${cleanPhone}, 9)`
            : sql`false`,
        ),
      ))
      .orderBy(desc(gramadoReservations.atualizadoEm), desc(gramadoReservations.data))
      .limit(1),
    lead.humanOwnerMemberId ? db.select({ name: companyMembers.name, email: companyMembers.email }).from(companyMembers).where(and(eq(companyMembers.id, lead.humanOwnerMemberId), eq(companyMembers.companyId, company.id))).limit(1) : Promise.resolve([]),
  ])
  const [reservation] = reservations

  return (
    <ChatWindow
      key={`${id}:${validAround ?? 'current'}:${navigation.initialContextOpen ? 'context' : 'chat'}:${navigation.fromAttention ? 'attention' : 'inbox'}`}
      highlightMessageId={validAround}
      backHref={navigation.backHref}
      conversationHref={navigation.conversationHref}
      initialContextOpen={navigation.initialContextOpen}
      lead={{
        id: lead.id,
        phone: lead.phone,
        name: lead.name ?? null,
        email: lead.email ?? null,
        company: lead.company ?? null,
        notes: lead.notes ?? null,
        eventType: lead.eventType,
        status: lead.status ?? null,
        priority: lead.priority ?? null,
        productName: lead.productName ?? null,
        productValue: lead.productValue ?? null,
        platform: lead.platform ?? null,
        channel: lead.channel || 'whatsapp',
        botPaused: lead.botPaused ?? false,
        botPausedAt: lead.botPausedAt ? lead.botPausedAt.toISOString() : null,
        botPausedBy: lead.botPausedBy ?? null,
        trackingSource: lead.trackingSource ?? null,
        utmCampaign: lead.utmCampaign ?? null,
        adsetName: lead.adsetName ?? null,
        adName: lead.adName ?? null,
        createdAt: lead.createdAt ? lead.createdAt.toISOString() : null,
        firstContactAt: lead.firstContactAt ? lead.firstContactAt.toISOString() : null,
        agentDisplayName: company.agentDisplayName ?? null,
        emailEngagement: getEmailEngagement(lead.miningTags),
        agentConversationId: lead.agentConversationId ?? null,
        agentCostUsd: lead.agentCostUsd ?? null,
        agentInputTokens: lead.agentInputTokens ?? null,
        agentOutputTokens: lead.agentOutputTokens ?? null,
        agentSyncedAt: lead.agentSyncedAt?.toISOString() ?? null,
        requestSummary: lead.requestSummary ?? null,
        requestMessageId: lead.requestMessageId ?? null,
        commitment: lead.commitment ?? null,
        nextAction: lead.nextAction ?? null,
        nextActionDueAt: lead.nextActionDueAt?.toISOString() ?? null,
        humanOwnerMemberId: lead.humanOwnerMemberId ?? null,
        humanOwnerName: ownerRows[0]?.name ?? ownerRows[0]?.email ?? null,
        sacCaseState: lead.sacCaseState ?? null,
        pipelineStage: lead.pipelineStage ?? null,
        responsibleAgent: lead.responsibleAgent ?? null,
        followUpDate: lead.followUpDate?.toISOString() ?? null,
        followUpNote: lead.followUpNote ?? null,
        contextVersion: lead.contextVersion ?? 1,
        reservation: reservation ? {
          id: reservation.reservaId,
          date: reservation.data,
          reservedTime: reservation.horarioReservado,
          arrivalTime: reservation.horarioChegada,
          people: reservation.pessoas,
          totalValue: reservation.valorTotal,
          status: reservation.status,
          notes: reservation.observacoes,
          unifiedTables: reservation.mesasUnificadas,
          updatedAt: reservation.atualizadoEm?.toISOString() ?? null,
        } : null,
      }}
      initialMessages={messagePage.messages.map(message => ({
        id: message.id,
        phone: message.phone,
        channel: message.channel || lead.channel || 'whatsapp',
        direction: message.direction,
        content: message.content ?? null,
        messageType: message.messageType ?? 'text',
        mediaUrl: message.mediaUrl ?? null,
        sentBy: message.sentBy ?? 'human',
        reasoning: message.reasoning ?? null,
        sentEmail: message.sentEmail ?? null,
        sendState: message.sendState ?? null,
        sendError: message.sendError ?? null,
        clientRequestId: message.clientRequestId ?? null,
        createdAt: message.createdAt?.toISOString() ?? null,
      }))}
      appointments={appointments.map(appointment => ({
        nativeId: appointment.nativeId,
        consultationAt: appointment.consultationAt.toISOString(),
        status: appointment.status,
        origin: appointment.origin,
        cancelledAt: appointment.cancelledAt?.toISOString() ?? null,
      }))}
      initialHistory={{ hasMore: messagePage.hasMore, nextCursor: messagePage.nextCursor }}
    />
  )
}
