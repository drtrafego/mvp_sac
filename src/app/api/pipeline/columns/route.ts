import { NextRequest, NextResponse } from 'next/server'
import { getCurrentCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import { settings, recoveryLeads } from '@/lib/db/schema'
import { eq, and, or } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const company = await getCurrentCompany()
    if (!company) {
      return NextResponse.json({ error: 'Empresa não autenticada' }, { status: 401 })
    }

    const [setting] = await db
      .select({ columns: settings.pipelineColumns })
      .from(settings)
      .where(eq(settings.companyId, company.id))

    return NextResponse.json({ columns: setting?.columns || null })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const company = await getCurrentCompany()
    if (!company) {
      return NextResponse.json({ error: 'Empresa não autenticada' }, { status: 401 })
    }

    const body = await req.json()
    const { columns, migrateFromColumn, migrateToColumn } = body

    if (!Array.isArray(columns)) {
      return NextResponse.json({ error: 'Colunas inválidas' }, { status: 400 })
    }

    if (migrateFromColumn && migrateToColumn) {
      await db
        .update(recoveryLeads)
        .set({
          status: migrateToColumn,
          pipelineStage: migrateToColumn,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(recoveryLeads.companyId, company.id),
            or(
              eq(recoveryLeads.status, migrateFromColumn),
              eq(recoveryLeads.pipelineStage, migrateFromColumn)
            )
          )
        )
    }

    await db
      .update(settings)
      .set({
        pipelineColumns: columns,
        updatedAt: new Date(),
      })
      .where(eq(settings.companyId, company.id))

    return NextResponse.json({ success: true, columns })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
