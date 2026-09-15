export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { eq, asc } from 'drizzle-orm'
import { ChatWindow } from '@/components/inbox/ChatWindow'

export default async function InboxChatPage({ params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params
  const id = parseInt(leadId)
  if (isNaN(id)) notFound()

  const [lead] = await db.select().from(recoveryLeads).where(eq(recoveryLeads.id, id))
  if (!lead) notFound()

  const messages = await db
    .select()
    .from(whatsappMessages)
    .where(eq(whatsappMessages.phone, lead.phone))
    .orderBy(asc(whatsappMessages.createdAt))
    .limit(300)

  return (
    <ChatWindow
      lead={{
        id: lead.id,
        phone: lead.phone,
        name: lead.name ?? null,
        eventType: lead.eventType,
        status: lead.status ?? null,
        productName: lead.productName ?? null,
      }}
      initialMessages={messages.map(m => ({
        id: m.id,
        direction: m.direction,
        content: m.content ?? null,
        messageType: m.messageType ?? null,
        mediaUrl: m.mediaUrl ?? null,
        sentBy: m.sentBy ?? null,
        createdAt: m.createdAt?.toISOString() ?? null,
      }))}
    />
  )
}
