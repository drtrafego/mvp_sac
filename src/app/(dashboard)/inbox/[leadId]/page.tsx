export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { appointmentMirror, recoveryLeads } from '@/lib/db/schema'
import { eq, desc, and, sql } from 'drizzle-orm'
import { ChatWindow } from '@/components/inbox/ChatWindow'
import { requireCompany } from '@/lib/auth'
import { getEmailEngagement } from '@/lib/email-engagement'
import { loadInboxMessagePage } from '@/lib/inbox-messages'

export default async function InboxChatPage({ params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params
  const id = parseInt(leadId)
  if (isNaN(id)) notFound()

  const company = await requireCompany()

  const [lead] = await db
    .select()
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))

  if (!lead) notFound()

  const cleanPhone = (lead.phone || '').replace(/\D/g, '')
  const last9 = cleanPhone.length >= 9 ? cleanPhone.slice(-9) : cleanPhone

  const messagePage = await loadInboxMessagePage({
    companyId: company.id,
    leadId: id,
    phone: lead.phone,
  })

  const appointments = cleanPhone
    ? await db
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
          )
        )
        .orderBy(desc(appointmentMirror.consultationAt))
        .limit(20)
    : []

  return (
    <ChatWindow
      lead={{
        id: lead.id,
        phone: lead.phone,
        name: lead.name ?? null,
        email: lead.email ?? null,
        company: lead.company ?? null,
        notes: lead.notes ?? null,
        eventType: lead.eventType,
        status: lead.status ?? null,
        productName: lead.productName ?? null,
        productValue: lead.productValue ?? null,
        platform: lead.platform ?? null,
        channel: lead.channel || 'whatsapp',
        botPaused: lead.botPaused ?? false,
        botPausedAt: lead.botPausedAt ? lead.botPausedAt.toISOString() : null,
        botPausedBy: lead.botPausedBy ?? null,
        trackingSource: lead.trackingSource ?? null,
        utmCampaign: lead.utmCampaign ?? null,
        createdAt: lead.createdAt ? lead.createdAt.toISOString() : null,
        firstContactAt: lead.firstContactAt ? lead.firstContactAt.toISOString() : null,
        agentDisplayName: company.agentDisplayName ?? null,
        emailEngagement: getEmailEngagement(lead.miningTags),
        agentConversationId: lead.agentConversationId ?? null,
        agentCostUsd: lead.agentCostUsd ?? null,
        agentInputTokens: lead.agentInputTokens ?? null,
        agentOutputTokens: lead.agentOutputTokens ?? null,
        agentSyncedAt: lead.agentSyncedAt?.toISOString() ?? null,
      }}
      initialMessages={messagePage.messages.map(m => ({
        id: m.id,
        phone: m.phone,
        channel: m.channel || lead.channel || 'whatsapp',
        direction: m.direction,
        content: m.content ?? null,
        messageType: m.messageType ?? 'text',
        mediaUrl: m.mediaUrl ?? null,
        sentBy: m.sentBy ?? 'human',
        reasoning: m.reasoning ?? null,
        sentEmail: m.sentEmail ?? null,
        createdAt: m.createdAt?.toISOString() ?? null,
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
