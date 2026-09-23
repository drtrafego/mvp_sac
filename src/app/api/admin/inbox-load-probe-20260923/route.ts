export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { companies, recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { loadInboxPage } from '@/lib/inbox-conversations'
import { getEmailEngagement } from '@/lib/email-engagement'

const TOKEN = 'inbox-load-probe-20260923-readonly'

export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.get('token') !== TOKEN) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const [largest] = await db
    .select({ companyId: recoveryLeads.companyId, slug: companies.slug, count: sql<number>`count(*)::int` })
    .from(recoveryLeads)
    .innerJoin(companies, eq(companies.id, recoveryLeads.companyId))
    .groupBy(recoveryLeads.companyId, companies.slug)
    .orderBy(desc(sql`count(*)`))
    .limit(1)
  if (!largest) return NextResponse.json({ error: 'no leads' }, { status: 404 })

  const oldStarted = performance.now()
  const leads = await db.select({
    id: recoveryLeads.id, phone: recoveryLeads.phone, name: recoveryLeads.name,
    email: recoveryLeads.email, eventType: recoveryLeads.eventType, status: recoveryLeads.status,
    productName: recoveryLeads.productName, productValue: recoveryLeads.productValue,
    platform: recoveryLeads.platform, channel: recoveryLeads.channel, botPaused: recoveryLeads.botPaused,
    botPausedAt: recoveryLeads.botPausedAt, botPausedBy: recoveryLeads.botPausedBy,
    trackingSource: recoveryLeads.trackingSource, utmCampaign: recoveryLeads.utmCampaign,
    createdAt: recoveryLeads.createdAt, updatedAt: recoveryLeads.updatedAt,
    miningTags: recoveryLeads.miningTags,
  }).from(recoveryLeads)
    .where(eq(recoveryLeads.companyId, largest.companyId))
    .orderBy(desc(sql`COALESCE(${recoveryLeads.lastActionAt}, ${recoveryLeads.updatedAt}, ${recoveryLeads.createdAt})`))
  const leadIds = leads.map(lead => lead.id)
  const phones = leads.map(lead => lead.phone).filter(Boolean)
  const byLead = await db.selectDistinctOn([whatsappMessages.leadId], {
    leadId: whatsappMessages.leadId, direction: whatsappMessages.direction,
    content: whatsappMessages.content, createdAt: whatsappMessages.createdAt,
  }).from(whatsappMessages)
    .where(and(eq(whatsappMessages.companyId, largest.companyId), inArray(whatsappMessages.leadId, leadIds)))
    .orderBy(whatsappMessages.leadId, desc(whatsappMessages.createdAt))
  const byPhone = await db.selectDistinctOn([whatsappMessages.phone], {
    phone: whatsappMessages.phone, direction: whatsappMessages.direction,
    content: whatsappMessages.content, createdAt: whatsappMessages.createdAt,
  }).from(whatsappMessages)
    .where(and(eq(whatsappMessages.companyId, largest.companyId), inArray(whatsappMessages.phone, phones)))
    .orderBy(whatsappMessages.phone, desc(whatsappMessages.createdAt))
  const unread = await db.select({ leadId: whatsappMessages.leadId, count: sql<number>`count(*)::int` })
    .from(whatsappMessages)
    .where(and(eq(whatsappMessages.companyId, largest.companyId), eq(whatsappMessages.direction, 'inbound'), inArray(whatsappMessages.leadId, leadIds)))
    .groupBy(whatsappMessages.leadId)
  const leadMessages = new Map(byLead.map(message => [message.leadId, message]))
  const phoneMessages = new Map(byPhone.map(message => [message.phone, message]))
  const unreadCounts = new Map(unread.map(row => [row.leadId, row.count]))
  const oldPayload = leads.map(lead => {
    const message = leadMessages.get(lead.id) || phoneMessages.get(lead.phone)
    return {
      id: lead.id, phone: lead.phone, name: lead.name, email: lead.email,
      eventType: lead.eventType, status: lead.status, productName: lead.productName,
      productValue: lead.productValue, platform: lead.platform, channel: lead.channel || 'whatsapp',
      botPaused: lead.botPaused ?? false, botPausedAt: lead.botPausedAt?.toISOString() ?? null,
      botPausedBy: lead.botPausedBy, trackingSource: lead.trackingSource, utmCampaign: lead.utmCampaign,
      createdAt: lead.createdAt?.toISOString() ?? null, lastMessage: message?.content ?? null,
      lastDirection: message?.direction ?? null,
      lastMessageAt: message?.createdAt?.toISOString() ?? lead.updatedAt?.toISOString() ?? null,
      lastInboundAt: message?.direction === 'inbound' ? message.createdAt?.toISOString() ?? null : null,
      lastOutboundAt: message?.direction === 'outbound' ? message.createdAt?.toISOString() ?? null : null,
      unread: unreadCounts.get(lead.id) ?? 0,
      emailEngagement: getEmailEngagement(lead.miningTags),
    }
  })
  const oldDurationMs = performance.now() - oldStarted

  const newStarted = performance.now()
  const page = await loadInboxPage({ companyId: largest.companyId })
  const newDurationMs = performance.now() - newStarted

  return NextResponse.json({
    company: largest,
    old: { rows: oldPayload.length, durationMs: Math.round(oldDurationMs), payloadBytes: Buffer.byteLength(JSON.stringify(oldPayload)) },
    paginated: { rows: page.conversations.length, durationMs: Math.round(newDurationMs), payloadBytes: Buffer.byteLength(JSON.stringify(page)), hasMore: page.hasMore },
  })
}
