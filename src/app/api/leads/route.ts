import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { eq, desc, and, gte, lte, sql } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { getDateRange } from '@/lib/date-utils'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const company = await requireCompany()
  const { searchParams } = new URL(req.url)
  const eventType = searchParams.get('event_type')
  const status = searchParams.get('status')
  const product = searchParams.get('product')
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 500)
  const offset = parseInt(searchParams.get('offset') ?? '0')
  const period = searchParams.get('period') ?? '30d'
  const fromStr = searchParams.get('from') ?? undefined
  const toStr = searchParams.get('to') ?? undefined

  // Retorna lista de produtos distintos para o dropdown de filtro
  if (searchParams.get('products_only') === 'true') {
    const conditions = [eq(recoveryLeads.companyId, company.id)]
    if (eventType) conditions.push(eq(recoveryLeads.eventType, eventType))
    const rows = await db
      .selectDistinct({ productName: recoveryLeads.productName })
      .from(recoveryLeads)
      .where(and(...conditions, sql`${recoveryLeads.productName} is not null`))
      .orderBy(recoveryLeads.productName)
      .limit(50)
    return NextResponse.json(rows.map(r => r.productName).filter(Boolean))
  }

  const { fromDate, toDate } = getDateRange(period, new Date(), fromStr, toStr)

  const conditions = [eq(recoveryLeads.companyId, company.id)]
  if (eventType) conditions.push(eq(recoveryLeads.eventType, eventType))
  if (status) conditions.push(eq(recoveryLeads.status, status))
  if (product) conditions.push(eq(recoveryLeads.productName, product))
  if (fromDate) conditions.push(gte(recoveryLeads.createdAt, fromDate))
  conditions.push(lte(recoveryLeads.createdAt, toDate))

  const leads = await db
    .select()
    .from(recoveryLeads)
    .where(and(...conditions))
    .orderBy(desc(recoveryLeads.createdAt))
    .limit(limit)
    .offset(offset)

  return NextResponse.json(leads)
}
