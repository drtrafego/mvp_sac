// ROTA TEMPORÁRIA DE VERIFICAÇÃO. Criada só para conferir contra produção
// que recuperada + direta = total antes de fechar a feature. Remover antes
// do merge final em main.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { companies, recoveryLeads } from '@/lib/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { isRecoveredSaleSql } from '@/lib/sales-attribution'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const token = req.headers.get('x-debug-token')
  if (!token || token !== process.env.DEBUG_REVENUE_TOKEN) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const allCompanies = await db.select({ id: companies.id, slug: companies.slug, name: companies.name }).from(companies)

  const results = await Promise.all(
    allCompanies.map(async (c) => {
      const [row] = await db
        .select({
          totalSales: sql<number>`cast(count(*) as int)`,
          totalRevenue: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}), 0) as bigint)`,
          recoveredRevenue: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}) filter (where ${isRecoveredSaleSql}), 0) as bigint)`,
          directRevenue: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}) filter (where not (${isRecoveredSaleSql})), 0) as bigint)`,
          recoveredCount: sql<number>`cast(count(*) filter (where ${isRecoveredSaleSql}) as int)`,
          directCount: sql<number>`cast(count(*) filter (where not (${isRecoveredSaleSql})) as int)`,
        })
        .from(recoveryLeads)
        .where(and(eq(recoveryLeads.companyId, c.id), eq(recoveryLeads.eventType, 'compra_aprovada')))

      return { company: c, ...row }
    }),
  )

  return NextResponse.json({ results })
}
