export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'

const TOKEN = 'codex-dashboard-distinct-20260922-reserva-confirmada'

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('token') !== TOKEN) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const rows = await db.execute(sql`
    with base as (
      select company_id, status, pipeline_stage, event_type, first_contact_at
      from recovery_leads
      where company_id in (3, 4)
    ),
    distinct_values as (
      select company_id, 'status' as column_name, status as value, count(*)::int as count
      from base
      group by company_id, status
      union all
      select company_id, 'pipeline_stage' as column_name, pipeline_stage as value, count(*)::int as count
      from base
      group by company_id, pipeline_stage
      union all
      select company_id, 'event_type' as column_name, event_type as value, count(*)::int as count
      from base
      group by company_id, event_type
    )
    select
      jsonb_build_object(
        'generated_at', now(),
        'distinct_values', (
          select coalesce(jsonb_agg(to_jsonb(distinct_values) order by company_id, column_name, value nulls first), '[]'::jsonb)
          from distinct_values
        ),
        'reservation_confirmed_exact', (
          select jsonb_build_object(
            'total', count(*)::int,
            'contacted', count(*) filter (where first_contact_at is not null)::int
          )
          from base
          where company_id = 4 and status = 'Reserva Confirmada'
        )
      ) as payload
  `)

  return NextResponse.json(rows[0]?.payload ?? {})
}
