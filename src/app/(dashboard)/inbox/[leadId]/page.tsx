export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { eq, asc, and, or, sql } from 'drizzle-orm'
import { ChatWindow } from '@/components/inbox/ChatWindow'
import { requireCompany } from '@/lib/auth'
import { queryAgentsDb } from '@/lib/db/agents-db'

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
  const last8 = cleanPhone.length >= 8 ? cleanPhone.slice(-8) : cleanPhone

  // Busca mensagens no banco local de forma rápida e indexada
  const messages = await db
    .select()
    .from(whatsappMessages)
    .where(
      and(
        eq(whatsappMessages.companyId, company.id),
        or(
          eq(whatsappMessages.leadId, id),
          lead.phone ? eq(whatsappMessages.phone, lead.phone) : sql`false`,
          cleanPhone ? eq(whatsappMessages.phone, cleanPhone) : sql`false`
        )
      )
    )
    .orderBy(asc(whatsappMessages.createdAt))
    .limit(300)

  return (
    <ChatWindow
      lead={{
        id: lead.id,
        phone: lead.phone,
        name: lead.name ?? null,
        email: lead.email ?? null,
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
        agentDisplayName: company.agentDisplayName ?? null,
      }}
      initialMessages={messages.map(m => ({
        id: m.id,
        phone: m.phone,
        channel: m.channel || lead.channel || 'whatsapp',
        direction: m.direction,
        content: m.content ?? null,
        messageType: m.messageType ?? 'text',
        mediaUrl: m.mediaUrl ?? null,
        sentBy: m.sentBy ?? 'human',
        createdAt: m.createdAt?.toISOString() ?? null,
      }))}
    />
  )
}
