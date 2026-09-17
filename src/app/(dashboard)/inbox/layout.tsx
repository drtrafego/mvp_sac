export const dynamic = 'force-dynamic'

import { db } from '@/lib/db'
import { recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { desc, eq, and, or, inArray, sql } from 'drizzle-orm'
import { ConversationList, type ConversationSummary } from '@/components/inbox/ConversationList'
import { requireCompany } from '@/lib/auth'

async function getConversations(companyId: number): Promise<ConversationSummary[]> {
  try {
    const leads = await db
      .select({
        id: recoveryLeads.id,
        phone: recoveryLeads.phone,
        name: recoveryLeads.name,
        email: recoveryLeads.email,
        eventType: recoveryLeads.eventType,
        status: recoveryLeads.status,
        productName: recoveryLeads.productName,
        productValue: recoveryLeads.productValue,
        platform: recoveryLeads.platform,
        channel: recoveryLeads.channel,
        botPaused: recoveryLeads.botPaused,
        botPausedAt: recoveryLeads.botPausedAt,
        botPausedBy: recoveryLeads.botPausedBy,
        trackingSource: recoveryLeads.trackingSource,
        utmCampaign: recoveryLeads.utmCampaign,
        createdAt: recoveryLeads.createdAt,
        updatedAt: recoveryLeads.updatedAt,
        lastActionAt: recoveryLeads.lastActionAt,
      })
      .from(recoveryLeads)
      .where(eq(recoveryLeads.companyId, companyId))
      .orderBy(desc(sql`COALESCE(${recoveryLeads.lastActionAt}, ${recoveryLeads.updatedAt}, ${recoveryLeads.createdAt})`))
      .limit(200)

    if (leads.length === 0) return []

    const leadIds = leads.map(l => l.id)
    const phones = leads.map(l => l.phone).filter((p): p is string => Boolean(p && p.trim()))

    const whereConditions = [eq(whatsappMessages.companyId, companyId)]
    if (phones.length > 0) {
      whereConditions.push(or(inArray(whatsappMessages.leadId, leadIds), inArray(whatsappMessages.phone, phones))!)
    } else {
      whereConditions.push(inArray(whatsappMessages.leadId, leadIds))
    }

    // Busca as mensagens mais recentes desses leads em UMA ÚNICA consulta indexada
    const messages = await db
      .select({
        id: whatsappMessages.id,
        leadId: whatsappMessages.leadId,
        phone: whatsappMessages.phone,
        direction: whatsappMessages.direction,
        content: whatsappMessages.content,
        createdAt: whatsappMessages.createdAt,
      })
      .from(whatsappMessages)
      .where(and(...whereConditions))
      .orderBy(desc(whatsappMessages.createdAt))
      .limit(500)

    // Agrupa mensagens por lead_id ou telefone em memória (ultra-rápido)
    const msgByLead = new Map<number, typeof messages[0]>()
    const msgByPhone = new Map<string, typeof messages[0]>()
    const unreadCountByLead = new Map<number, number>()

    for (const m of messages) {
      if (m.leadId && !msgByLead.has(m.leadId)) {
        msgByLead.set(m.leadId, m)
      }
      if (m.phone && !msgByPhone.has(m.phone)) {
        msgByPhone.set(m.phone, m)
      }
      if (m.leadId && m.direction === 'inbound') {
        unreadCountByLead.set(m.leadId, (unreadCountByLead.get(m.leadId) || 0) + 1)
      }
    }

    const mapped: ConversationSummary[] = leads.map(l => {
      const lastMsg = (l.id ? msgByLead.get(l.id) : null) || (l.phone ? msgByPhone.get(l.phone) : null)
      return {
        id: l.id,
        phone: l.phone,
        name: l.name,
        email: l.email,
        eventType: l.eventType,
        status: l.status,
        productName: l.productName,
        productValue: l.productValue,
        platform: l.platform,
        channel: l.channel || 'whatsapp',
        botPaused: l.botPaused ?? false,
        botPausedAt: l.botPausedAt ? l.botPausedAt.toISOString() : null,
        botPausedBy: l.botPausedBy,
        trackingSource: l.trackingSource,
        utmCampaign: l.utmCampaign,
        createdAt: l.createdAt ? l.createdAt.toISOString() : null,
        lastMessage: lastMsg?.content ?? null,
        lastDirection: lastMsg?.direction ?? null,
        lastMessageAt: lastMsg?.createdAt ? lastMsg.createdAt.toISOString() : (l.updatedAt ? l.updatedAt.toISOString() : null),
        lastInboundAt: lastMsg?.direction === 'inbound' && lastMsg.createdAt ? lastMsg.createdAt.toISOString() : null,
        lastOutboundAt: lastMsg?.direction === 'outbound' && lastMsg.createdAt ? lastMsg.createdAt.toISOString() : null,
        unread: unreadCountByLead.get(l.id) || 0,
      }
    })

    return mapped
  } catch (err) {
    console.error('[Inbox layout getConversations error]:', err)
    return []
  }
}

export default async function InboxLayout({ children }: { children: React.ReactNode }) {
  const company = await requireCompany()
  const conversations = await getConversations(company.id)

  return (
    <div className="flex flex-1 min-h-0 h-full w-full overflow-hidden bg-surface-base">
      <ConversationList initial={conversations} />
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col h-full bg-surface-base">{children}</div>
    </div>
  )
}
