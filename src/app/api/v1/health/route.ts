import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { companies } from '@/lib/db/schema'
import { sql } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const rows = await db
      .select({
        id: companies.id,
        name: companies.name,
        slug: companies.slug,
        totalLeads: sql<number>`COALESCE((SELECT COUNT(*)::int FROM recovery_leads WHERE recovery_leads.company_id = "companies"."id"), 0)`,
        totalMessages: sql<number>`COALESCE((SELECT COUNT(*)::int FROM whatsapp_messages WHERE whatsapp_messages.company_id = "companies"."id"), 0)`,
      })
      .from(companies)
      .orderBy(companies.id)

    return NextResponse.json({
      ok: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
      totalCompanies: rows.length,
      companies: rows,
    })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || String(err) }, { status: 500 })
  }
}
