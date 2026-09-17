export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads, whatsappMessages } from '@/lib/db/schema'
<<<<<<< HEAD
import { desc, eq, sql, and, or, ilike, inArray } from 'drizzle-orm'
=======
import { desc, eq, sql, and, or, inArray, ilike } from 'drizzle-orm'
>>>>>>> 23a6d8c (feat(punchlist): resolve Instagram webhook HMAC, fix companies count, inbox inArray query, seed Amanda company and audit routes)
import { requireCompany } from '@/lib/auth'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const company = await requireCompany()
  const { searchParams } = new URL(req.url)

  const chFilter = searchParams.get('channel') // all | whatsapp | instagram | email | mineracao
  const statusFilter = searchParams.get('status') // all | paused | active
  const q = searchParams.get('q')?.trim()

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
    .where(eq(recoveryLeads.companyId, company.id))
    .orderBy(desc(sql`COALESCE(${recoveryLeads.lastActionAt}, ${recoveryLeads.updatedAt}, ${recoveryLeads.createdAt})`))
    .limit(200)

  if (leads.length === 0) return NextResponse.json([])

  const leadIds = leads.map(l => l.id)
  const phones = leads.map(l => l.phone).filter((p): p is string => Boolean(p && p.trim()))

  const whereConditions = [eq(whatsappMessages.companyId, company.id)]
  if (phones.length > 0) {
    whereConditions.push(or(inArray(whatsappMessages.leadId, leadIds), inArray(whatsappMessages.phone, phones))!)
  } else {
    whereConditions.push(inArray(whatsappMessages.leadId, leadIds))
  }

  // inArray (IN (...)), não ANY(${array}): o sql`` do drizzle expande um array
  // interpolado em "(p1, p2, ...)", e ANY() em volta disso vira "ANY((1,2,3))",
  // que o Postgres rejeita ("op ANY/ALL (array) requires array on right side").
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

  let mapped = leads.map(l => {
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

  if (chFilter && chFilter !== 'all') {
    mapped = mapped.filter(l => {
      const ch = (l.channel || 'whatsapp').toLowerCase()
      const pl = (l.platform || '').toLowerCase()
      const src = (l.trackingSource || '').toLowerCase()
      if (chFilter === 'instagram') {
        return ch === 'instagram' || pl === 'instagram' || src.includes('instagram') || l.phone.startsWith('ig_')
      }
      if (chFilter === 'email') {
        return ch === 'email' || src.includes('email') || src.includes('brevo')
      }
      if (chFilter === 'mineracao') {
        return ch === 'mineracao' || pl === 'mineracao' || src.includes('mineracao') || src.includes('prospeccao')
      }
      if (chFilter === 'whatsapp') {
        return ch === 'whatsapp' && !l.phone.startsWith('ig_')
      }
      return true
    })
  }

  if (statusFilter && statusFilter !== 'all') {
    if (statusFilter === 'paused') {
      mapped = mapped.filter(l => l.botPaused === true)
    } else if (statusFilter === 'active') {
      mapped = mapped.filter(l => !l.botPaused)
    }
  }

  if (q) {
    const term = q.toLowerCase()
    mapped = mapped.filter(
      l =>
        l.name?.toLowerCase().includes(term) ||
        l.phone.toLowerCase().includes(term) ||
        l.email?.toLowerCase().includes(term) ||
        l.lastMessage?.toLowerCase().includes(term) ||
        l.productName?.toLowerCase().includes(term)
    )
  }

  return NextResponse.json(mapped)
}
