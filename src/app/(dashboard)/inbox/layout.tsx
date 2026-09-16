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
          WHERE (
            wm.lead_id = recovery_leads.id 
            OR (wm.phone = recovery_leads.phone AND recovery_leads.phone IS NOT NULL AND recovery_leads.phone != '')
            OR (
              length(regexp_replace(COALESCE(wm.phone, ''), '\\D', '', 'g')) >= 8 
              AND length(regexp_replace(COALESCE(recovery_leads.phone, ''), '\\D', '', 'g')) >= 8 
              AND right(regexp_replace(wm.phone, '\\D', '', 'g'), 8) = right(regexp_replace(recovery_leads.phone, '\\D', '', 'g'), 8)
            )
          )
          AND wm.company_id = ${companyId}
          ORDER BY wm.created_at DESC LIMIT 1
        )`,
        lastDirection: sql<string | null>`(
          SELECT wm.direction FROM whatsapp_messages wm
          WHERE (
            wm.lead_id = recovery_leads.id 
            OR (wm.phone = recovery_leads.phone AND recovery_leads.phone IS NOT NULL AND recovery_leads.phone != '')
            OR (
              length(regexp_replace(COALESCE(wm.phone, ''), '\\D', '', 'g')) >= 8 
              AND length(regexp_replace(COALESCE(recovery_leads.phone, ''), '\\D', '', 'g')) >= 8 
              AND right(regexp_replace(wm.phone, '\\D', '', 'g'), 8) = right(regexp_replace(recovery_leads.phone, '\\D', '', 'g'), 8)
            )
          )
          AND wm.company_id = ${companyId}
          ORDER BY wm.created_at DESC LIMIT 1
        )`,
        lastMessageAt: sql<string | null>`(
          SELECT wm.created_at::text FROM whatsapp_messages wm
          WHERE (
            wm.lead_id = recovery_leads.id 
            OR (wm.phone = recovery_leads.phone AND recovery_leads.phone IS NOT NULL AND recovery_leads.phone != '')
            OR (
              length(regexp_replace(COALESCE(wm.phone, ''), '\\D', '', 'g')) >= 8 
              AND length(regexp_replace(COALESCE(recovery_leads.phone, ''), '\\D', '', 'g')) >= 8 
              AND right(regexp_replace(wm.phone, '\\D', '', 'g'), 8) = right(regexp_replace(recovery_leads.phone, '\\D', '', 'g'), 8)
            )
          )
          AND wm.company_id = ${companyId}
          ORDER BY wm.created_at DESC LIMIT 1
        )`,
        lastInboundAt: sql<string | null>`(
          SELECT wm.created_at::text FROM whatsapp_messages wm
          WHERE (
            wm.lead_id = recovery_leads.id 
            OR (wm.phone = recovery_leads.phone AND recovery_leads.phone IS NOT NULL AND recovery_leads.phone != '')
            OR (
              length(regexp_replace(COALESCE(wm.phone, ''), '\\D', '', 'g')) >= 8 
              AND length(regexp_replace(COALESCE(recovery_leads.phone, ''), '\\D', '', 'g')) >= 8 
              AND right(regexp_replace(wm.phone, '\\D', '', 'g'), 8) = right(regexp_replace(recovery_leads.phone, '\\D', '', 'g'), 8)
            )
          )
          AND wm.company_id = ${companyId}
          AND wm.direction = 'inbound'
          ORDER BY wm.created_at DESC LIMIT 1
        )`,
        lastOutboundAt: sql<string | null>`(
          SELECT wm.created_at::text FROM whatsapp_messages wm
          WHERE (
            wm.lead_id = recovery_leads.id 
            OR (wm.phone = recovery_leads.phone AND recovery_leads.phone IS NOT NULL AND recovery_leads.phone != '')
            OR (
              length(regexp_replace(COALESCE(wm.phone, ''), '\\D', '', 'g')) >= 8 
              AND length(regexp_replace(COALESCE(recovery_leads.phone, ''), '\\D', '', 'g')) >= 8 
              AND right(regexp_replace(wm.phone, '\\D', '', 'g'), 8) = right(regexp_replace(recovery_leads.phone, '\\D', '', 'g'), 8)
            )
          )
          AND wm.company_id = ${companyId}
          AND wm.direction = 'outbound'
          ORDER BY wm.created_at DESC LIMIT 1
        )`,
        unread: sql<number>`(
          SELECT COUNT(*) FROM whatsapp_messages wm
          WHERE (
            wm.lead_id = recovery_leads.id 
            OR (wm.phone = recovery_leads.phone AND recovery_leads.phone IS NOT NULL AND recovery_leads.phone != '')
            OR (
              length(regexp_replace(COALESCE(wm.phone, ''), '\\D', '', 'g')) >= 8 
              AND length(regexp_replace(COALESCE(recovery_leads.phone, ''), '\\D', '', 'g')) >= 8 
              AND right(regexp_replace(wm.phone, '\\D', '', 'g'), 8) = right(regexp_replace(recovery_leads.phone, '\\D', '', 'g'), 8)
            )
          )
          AND wm.company_id = ${companyId}
          AND wm.direction = 'inbound'
          AND wm.created_at > COALESCE((
            SELECT wm2.created_at FROM whatsapp_messages wm2
            WHERE (
              wm2.lead_id = recovery_leads.id 
              OR (wm2.phone = recovery_leads.phone AND recovery_leads.phone IS NOT NULL AND recovery_leads.phone != '')
              OR (
                length(regexp_replace(COALESCE(wm2.phone, ''), '\\D', '', 'g')) >= 8 
                AND length(regexp_replace(COALESCE(recovery_leads.phone, ''), '\\D', '', 'g')) >= 8 
                AND right(regexp_replace(wm2.phone, '\\D', '', 'g'), 8) = right(regexp_replace(recovery_leads.phone, '\\D', '', 'g'), 8)
              )
            )
            AND wm2.company_id = ${companyId}
            AND wm2.direction = 'outbound'
            ORDER BY wm2.created_at DESC LIMIT 1
          ), '2000-01-01')
        )`,
      })
      .from(recoveryLeads)
      .where(eq(recoveryLeads.companyId, companyId))
      .orderBy(
        desc(
          sql`COALESCE((
            SELECT MAX(wm.created_at) FROM whatsapp_messages wm 
            WHERE wm.lead_id = recovery_leads.id 
               OR (wm.phone = recovery_leads.phone AND recovery_leads.phone IS NOT NULL AND recovery_leads.phone != '')
               OR (
                 length(regexp_replace(COALESCE(wm.phone, ''), '\\D', '', 'g')) >= 8 
                 AND length(regexp_replace(COALESCE(recovery_leads.phone, ''), '\\D', '', 'g')) >= 8 
                 AND right(regexp_replace(wm.phone, '\\D', '', 'g'), 8) = right(regexp_replace(recovery_leads.phone, '\\D', '', 'g'), 8)
               )
          ), ${recoveryLeads.updatedAt}, ${recoveryLeads.createdAt})`
        )
      )
      .limit(3000)

    const mapped = leads.map(l => ({
      ...l,
      botPaused: l.botPaused ?? false,
      botPausedAt: l.botPausedAt ? l.botPausedAt.toISOString() : null,
      createdAt: l.createdAt ? l.createdAt.toISOString() : null,
      channel: l.channel || 'whatsapp',
    }))

    // Deduplicação e agrupamento consolidado por pessoa (telefone normalizado ou email)
    const personMap = new Map<string, ConversationSummary>()
    for (const c of mapped) {
      const rawDigits = (c.phone || '').replace(/\D/g, '')
      const key = rawDigits.length >= 8
        ? `phone_${rawDigits.slice(-8)}`
        : c.email
        ? `email_${c.email.toLowerCase().trim()}`
        : `id_${c.id}`

      const currentSources = [c.trackingSource, c.platform].filter(Boolean) as string[]
      const currentEvents = [c.eventType].filter(Boolean) as string[]

      const existing = personMap.get(key)
      if (!existing) {
        personMap.set(key, {
          ...c,
          allOrigins: Array.from(new Set(currentSources)),
          allEventTypes: Array.from(new Set(currentEvents)),
        })
      } else {
        const existingTime = existing.lastMessageAt ? new Date(existing.lastMessageAt).getTime() : 0
        const currentTime = c.lastMessageAt ? new Date(c.lastMessageAt).getTime() : 0
        const totalUnread = (existing.unread || 0) + (c.unread || 0)

        const mergedSources = Array.from(new Set([
          ...(existing.allOrigins || [existing.trackingSource, existing.platform].filter(Boolean) as string[]),
          ...currentSources,
        ]))

        const mergedEvents = Array.from(new Set([
          ...(existing.allEventTypes || [existing.eventType].filter(Boolean) as string[]),
          ...currentEvents,
        ]))

        if (currentTime > existingTime) {
          personMap.set(key, {
            ...c,
            unread: totalUnread,
            name: c.name || existing.name,
            allOrigins: mergedSources,
            allEventTypes: mergedEvents,
          })
        } else {
          existing.unread = totalUnread
          if (!existing.name && c.name) existing.name = c.name
          existing.allOrigins = mergedSources
          existing.allEventTypes = mergedEvents
        }
      }
    }

    return Array.from(personMap.values()).sort((a, b) => {
      const timeA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : (a.createdAt ? new Date(a.createdAt).getTime() : 0)
      const timeB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : (b.createdAt ? new Date(b.createdAt).getTime() : 0)
      return timeB - timeA
    })
  } catch {
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
