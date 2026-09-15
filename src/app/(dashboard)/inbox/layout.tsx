export const dynamic = 'force-dynamic'

import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { desc, eq, sql } from 'drizzle-orm'
import { ConversationList } from '@/components/inbox/ConversationList'
import { requireCompany } from '@/lib/auth'

async function getConversations(companyId: number) {
  try {
    const leads = await db
      .select({
        id: recoveryLeads.id,
        phone: recoveryLeads.phone,
        name: recoveryLeads.name,
        eventType: recoveryLeads.eventType,
        status: recoveryLeads.status,
        productName: recoveryLeads.productName,
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
      .limit(100)

    return leads
  } catch {
    return []
  }
}

export default async function InboxLayout({ children }: { children: React.ReactNode }) {
  const company = await requireCompany()
  const conversations = await getConversations(company.id)

  // bleed-shell anula o padding do <main>, inclusive o espaço da tab bar no celular
  return (
    <div className="bleed-shell flex flex-1 min-h-0 overflow-hidden">
      <ConversationList initial={conversations} />
      <div className="flex-1 min-w-0 overflow-hidden">{children}</div>
    </div>
  )
}
