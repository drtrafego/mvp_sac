import { and, eq, inArray } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'
import { requireCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { summarizeDispatchEligibility } from '@/lib/mass-dispatch-eligibility'
import { filterConditions } from '@/app/api/leads/dispatch/route'

function parseIds(value: string | null): number[] | null {
  if (!value) return null
  const ids = value.split(',').map(item => Number(item.trim()))
  if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) return null
  return ids
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const company = await requireCompany()
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('mode')

  if (mode === 'ids') {
    const requestedIds = parseIds(searchParams.get('lead_ids'))
    if (!requestedIds) return NextResponse.json({ error: 'Seleção de leads inválida' }, { status: 400 })
    const rows = await db.select({ id: recoveryLeads.id, phone: recoveryLeads.phone })
      .from(recoveryLeads)
      .where(and(eq(recoveryLeads.companyId, company.id), inArray(recoveryLeads.id, [...new Set(requestedIds)])))
    return NextResponse.json({ ok: true, eligibility: summarizeDispatchEligibility(requestedIds, rows) })
  }

  if (mode === 'filter') {
    let filter: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(searchParams.get('filter') ?? '')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
      filter = parsed as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Filtro de leads inválido' }, { status: 400 })
    }
    const rows = await db.select({ id: recoveryLeads.id, phone: recoveryLeads.phone })
      .from(recoveryLeads)
      .where(and(...filterConditions(company.id, filter, { requirePhone: false })))
    return NextResponse.json({ ok: true, eligibility: summarizeDispatchEligibility(rows.map(row => row.id), rows) })
  }

  return NextResponse.json({ error: 'Modo de seleção inválido' }, { status: 400 })
}
