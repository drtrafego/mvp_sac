export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { desc, eq, sql, and, or, ilike } from 'drizzle-orm'
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
      lastMessage: sql<string | null>`(
        SELECT wm.content FROM whatsapp_messages wm
        WHERE wm.phone = ${recoveryLeads.phone} AND wm.company_id = ${company.id}
        ORDER BY wm.created_at DESC LIMIT 1
      )`,
      lastDirection: sql<string | null>`(
        SELECT wm.direction FROM whatsapp_messages wm
        WHERE wm.phone = ${recoveryLeads.phone} AND wm.company_id = ${company.id}
        ORDER BY wm.created_at DESC LIMIT 1
      )`,
      lastMessageAt: sql<string | null>`(
        SELECT wm.created_at::text FROM whatsapp_messages wm
        WHERE wm.phone = ${recoveryLeads.phone} AND wm.company_id = ${company.id}
        ORDER BY wm.created_at DESC LIMIT 1
      )`,
      unread: sql<number>`(
        SELECT COUNT(*) FROM whatsapp_messages wm
        WHERE wm.phone = ${recoveryLeads.phone}
          AND wm.company_id = ${company.id}
          AND wm.direction = 'inbound'
          AND wm.created_at > COALESCE((
            SELECT wm2.created_at FROM whatsapp_messages wm2
            WHERE wm2.phone = ${recoveryLeads.phone}
              AND wm2.company_id = ${company.id}
              AND wm2.direction = 'outbound'
            ORDER BY wm2.created_at DESC LIMIT 1
          ), '2000-01-01')
      )`,
    })
    .from(recoveryLeads)
    .where(eq(recoveryLeads.companyId, company.id))
    .orderBy(desc(recoveryLeads.updatedAt))
    .limit(200)

  let filtered = leads

  if (chFilter && chFilter !== 'all') {
    filtered = filtered.filter(l => {
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
      filtered = filtered.filter(l => l.botPaused === true)
    } else if (statusFilter === 'active') {
      filtered = filtered.filter(l => !l.botPaused)
    }
  }

  if (q) {
    const term = q.toLowerCase()
    filtered = filtered.filter(
      l =>
        l.name?.toLowerCase().includes(term) ||
        l.phone.toLowerCase().includes(term) ||
        l.email?.toLowerCase().includes(term) ||
        l.lastMessage?.toLowerCase().includes(term) ||
        l.productName?.toLowerCase().includes(term)
    )
  }

  return NextResponse.json(filtered)
}
