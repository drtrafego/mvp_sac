export const dynamic = 'force-dynamic'

import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { desc, eq, sql } from 'drizzle-orm'
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
        lastMessage: sql<string | null>`(
          SELECT wm.content FROM whatsapp_messages wm
          WHERE wm.phone = ${recoveryLeads.phone} AND wm.company_id = ${companyId}
          ORDER BY wm.created_at DESC LIMIT 1
        )`,
        lastDirection: sql<string | null>`(
          SELECT wm.direction FROM whatsapp_messages wm
          WHERE wm.phone = ${recoveryLeads.phone} AND wm.company_id = ${companyId}
          ORDER BY wm.created_at DESC LIMIT 1
        )`,
        lastMessageAt: sql<string | null>`(
          SELECT wm.created_at::text FROM whatsapp_messages wm
          WHERE wm.phone = ${recoveryLeads.phone} AND wm.company_id = ${companyId}
          ORDER BY wm.created_at DESC LIMIT 1
        )`,
        unread: sql<number>`(
          SELECT COUNT(*) FROM whatsapp_messages wm
          WHERE wm.phone = ${recoveryLeads.phone}
            AND wm.company_id = ${companyId}
            AND wm.direction = 'inbound'
            AND wm.created_at > COALESCE((
              SELECT wm2.created_at FROM whatsapp_messages wm2
              WHERE wm2.phone = ${recoveryLeads.phone}
                AND wm2.company_id = ${companyId}
                AND wm2.direction = 'outbound'
              ORDER BY wm2.created_at DESC LIMIT 1
            ), '2000-01-01')
        )`,
      })
      .from(recoveryLeads)
      .where(eq(recoveryLeads.companyId, companyId))
      .orderBy(desc(recoveryLeads.updatedAt))
      .limit(150)

    return leads.map(l => ({
      ...l,
      botPaused: l.botPaused ?? false,
      botPausedAt: l.botPausedAt ? l.botPausedAt.toISOString() : null,
      createdAt: l.createdAt ? l.createdAt.toISOString() : null,
      channel: l.channel || 'whatsapp',
    }))
  } catch {
    return []
  }
}

export default async function InboxLayout({ children }: { children: React.ReactNode }) {
  const company = await requireCompany()
  const conversations = await getConversations(company.id)

  return (
    <div className="bleed-shell flex flex-1 min-h-0 overflow-hidden bg-surface-base">
      <ConversationList initial={conversations} />
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col">{children}</div>
    </div>
  )
}
