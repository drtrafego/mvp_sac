export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { leadTags, recoveryLeads } from '@/lib/db/schema'
import { requireCompany } from '@/lib/auth'

/** Lista tags já usadas pela empresa para seleção nos formulários de lead. */
export async function GET(): Promise<NextResponse> {
  const company = await requireCompany()
  const rows = await db
    .selectDistinct({ tag: leadTags.tag })
    .from(leadTags)
    .innerJoin(recoveryLeads, eq(recoveryLeads.id, leadTags.leadId))
    .where(eq(recoveryLeads.companyId, company.id))
    .orderBy(asc(leadTags.tag))
    .limit(200)

  return NextResponse.json({ tags: rows.map(row => row.tag) })
}
