export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { appointmentMirror, companies } from '@/lib/db/schema'
import { syncAgentsAndCompanies } from '@/lib/sync-agents'

const TOKEN = 'probe-4c834e39-177b-45fa-8ec9-c4637533a090'

function mask(value: string | null): string | null {
  if (!value) return null
  if (value.length <= 3) return '*'.repeat(value.length)
  return '*'.repeat(value.length - 3) + value.slice(-3)
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get('x-smoke-token') !== TOKEN) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const report = await syncAgentsAndCompanies()
  const [company] = await db.select().from(companies).where(eq(companies.slug, 'drlucas')).limit(1)
  if (!company) return NextResponse.json({ ok: false, error: 'company_not_found' }, { status: 404 })

  const [latest] = await db
    .select()
    .from(appointmentMirror)
    .where(and(eq(appointmentMirror.companyId, company.id), sql`${appointmentMirror.consultationAt} is not null`))
    .orderBy(desc(appointmentMirror.sourceSyncedAt), desc(appointmentMirror.nativeId))
    .limit(1)
  const [{ count }] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(appointmentMirror)
    .where(eq(appointmentMirror.companyId, company.id))

  return NextResponse.json({
    ok: report.ok,
    count,
    sample: latest ? {
      name: mask(latest.name),
      phone: mask(latest.phone),
      consultationAt: latest.consultationAt.toISOString(),
      status: latest.status,
      origin: latest.origin,
      cancelledAt: latest.cancelledAt?.toISOString() ?? null,
      sourceSyncedAt: latest.sourceSyncedAt.toISOString(),
    } : null,
  })
}
