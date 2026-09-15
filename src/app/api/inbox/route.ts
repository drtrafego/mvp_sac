export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { desc, eq, sql, and } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'

export async function GET(): Promise<NextResponse> {
  const company = await requireCompany()

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
    .limit(100)

  return NextResponse.json(leads)
}
