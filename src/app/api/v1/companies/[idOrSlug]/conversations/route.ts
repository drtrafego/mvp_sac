export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { authenticateAgentRequest } from '@/lib/agent-auth'
import { eq, desc, sql } from 'drizzle-orm'

type Params = { params: Promise<{ idOrSlug: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  const companyId = context.company.id

  const leads = await db
    .select({
      id: recoveryLeads.id,
      phone: recoveryLeads.phone,
      name: recoveryLeads.name,
      email: recoveryLeads.email,
      eventType: recoveryLeads.eventType,
      status: recoveryLeads.status,
      pipelineStage: recoveryLeads.pipelineStage,
      productName: recoveryLeads.productName,
      productValue: recoveryLeads.productValue,
      platform: recoveryLeads.platform,
      channel: recoveryLeads.channel,
      botPaused: recoveryLeads.botPaused,
      trackingSource: recoveryLeads.trackingSource,
      utmCampaign: recoveryLeads.utmCampaign,
      createdAt: recoveryLeads.createdAt,
      lastMessage: sql<string | null>`(
        SELECT wm.content FROM whatsapp_messages wm
        WHERE (wm.lead_id = ${recoveryLeads.id} OR wm.phone = ${recoveryLeads.phone} OR right(regexp_replace(wm.phone, '\\D', '', 'g'), 9) = right(regexp_replace(${recoveryLeads.phone}, '\\D', '', 'g'), 9))
          AND wm.company_id = ${companyId}
        ORDER BY wm.created_at DESC LIMIT 1
      )`,
      lastMessageAt: sql<string | null>`(
        SELECT wm.created_at::text FROM whatsapp_messages wm
        WHERE (wm.lead_id = ${recoveryLeads.id} OR wm.phone = ${recoveryLeads.phone} OR right(regexp_replace(wm.phone, '\\D', '', 'g'), 9) = right(regexp_replace(${recoveryLeads.phone}, '\\D', '', 'g'), 9))
          AND wm.company_id = ${companyId}
        ORDER BY wm.created_at DESC LIMIT 1
      )`,
      unread: sql<number>`(
        SELECT COUNT(*) FROM whatsapp_messages wm
        WHERE (wm.lead_id = ${recoveryLeads.id} OR wm.phone = ${recoveryLeads.phone} OR right(regexp_replace(wm.phone, '\\D', '', 'g'), 9) = right(regexp_replace(${recoveryLeads.phone}, '\\D', '', 'g'), 9))
          AND wm.company_id = ${companyId}
          AND wm.direction = 'inbound'
      )`,
    })
    .from(recoveryLeads)
    .where(eq(recoveryLeads.companyId, companyId))
    .orderBy(desc(recoveryLeads.updatedAt))
    .limit(250)

  // Deduplicação e consolidação por pessoa
  const personMap = new Map<string, any>()
  for (const c of leads) {
    const rawDigits = (c.phone || '').replace(/\D/g, '')
    const key = rawDigits.length >= 9
      ? `phone_${rawDigits.slice(-9)}`
      : c.email
      ? `email_${c.email.toLowerCase().trim()}`
      : `raw_${c.phone}`

    const existing = personMap.get(key)
    if (!existing) {
      personMap.set(key, { ...c })
    } else {
      const existingTime = existing.lastMessageAt ? new Date(existing.lastMessageAt).getTime() : 0
      const currentTime = c.lastMessageAt ? new Date(c.lastMessageAt).getTime() : 0
      const totalUnread = (existing.unread || 0) + (c.unread || 0)

      if (currentTime > existingTime) {
        personMap.set(key, { ...c, unread: totalUnread, name: c.name || existing.name })
      } else {
        existing.unread = totalUnread
        if (!existing.name && c.name) existing.name = c.name
      }
    }
  }

  const conversations = Array.from(personMap.values()).sort((a, b) => {
    const timeA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
    const timeB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
    return timeB - timeA
  })

  return NextResponse.json({
    ok: true,
    company: { id: context.company.id, slug: context.company.slug },
    count: conversations.length,
    conversations,
  })
}
