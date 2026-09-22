export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'
import postgres from 'postgres'

const SUFFIXES = ['1201', '4853', '5830'] as const
const TODAY = '2026-09-22'
const PROBE_LABEL = 'ctwa-readonly-2026-09-22'

type Row = Record<string, any>

function toTransactionPooler(url: string): string {
  if (url.includes('pooler.supabase.com') && url.includes(':5432')) {
    return url.replace(':5432', ':6543')
  }
  return url
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function digits(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '')
}

function maskPhone(value: unknown): string | null {
  const d = digits(value)
  if (!d) return null
  return `${'*'.repeat(Math.max(0, d.length - 4))}${d.slice(-4)}`
}

function sanitizeRows(rows: Row[]): Row[] {
  return rows.map((row) => {
    const d = digits(row.phone_norm)
    const next: Row = { ...row }
    delete next.phone_norm
    next.phone_norm_masked = maskPhone(row.phone_norm)
    next.phone_digits_length = d.length
    return next
  })
}

function selectList(columns: Set<string>): string {
  const parts = [
    "right(regexp_replace(c.phone_norm, '\\D', '', 'g'), 9) as phone_last9",
    "right(regexp_replace(c.phone_norm, '\\D', '', 'g'), 4) as phone_last4",
    'c.phone_norm',
  ]

  for (const column of [
    'created_at',
    'campaign_name',
    'ad_name',
    'account_name',
    'account_id',
    'ad_account_name',
    'ad_account_id',
    'source',
    'page_name',
    'page_id',
  ]) {
    if (!columns.has(column)) continue
    if (column === 'created_at') {
      parts.push(`c.${quoteIdent(column)}::text as ${quoteIdent(column)}`)
    } else if (column !== 'phone_norm') {
      parts.push(`c.${quoteIdent(column)}`)
    }
  }

  return parts.join(', ')
}

function orderByCreated(columns: Set<string>): string {
  return columns.has('created_at') ? 'order by c.created_at desc nulls last' : ''
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

export async function GET() {
  const agentsCandidate: [string, string | undefined][] = [
    ['CRM_DATABASE_URL', process.env.CRM_DATABASE_URL],
    ['SUPABASE_DATABASE_URL', process.env.SUPABASE_DATABASE_URL],
    ['AGENTS_DATABASE_URL', process.env.AGENTS_DATABASE_URL],
  ]
  const agentsSource = agentsCandidate.find(([, value]) => Boolean(value))

  if (!agentsSource?.[1]) {
    return NextResponse.json(
      { ok: false, error: 'Agents DB env not configured', checked: agentsCandidate.map(([name]) => name) },
      { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0' } }
    )
  }

  const localSql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null
  const agentsSql = postgres(toTransactionPooler(agentsSource[1]), {
    ssl: 'require',
    max: 1,
    idle_timeout: 5,
    connect_timeout: 20,
    prepare: false,
  })

  try {
    let localLeadRows: Row[] = []
    let localLeadError: string | null = null

    if (localSql) {
      try {
        localLeadRows = (await localSql`
          select
            id,
            right(regexp_replace(phone, '\\D', '', 'g'), 9) as phone_last9,
            right(regexp_replace(phone, '\\D', '', 'g'), 4) as phone_last4,
            created_at::text as created_at,
            tracking_source,
            utm_campaign
          from recovery_leads
          where company_id = 292
            and right(regexp_replace(phone, '\\D', '', 'g'), 4) in ('1201', '4853', '5830')
          order by created_at desc
          limit 30
        `) as Row[]
      } catch (error) {
        localLeadError = String(error)
      }
    }

    const columnRows = await agentsSql.unsafe<Row[]>(`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'ctwa_referrals'
      order by ordinal_position
    `)
    const columns = new Set(columnRows.map((row) => String(row.column_name)))

    if (!columns.has('phone_norm')) {
      return NextResponse.json(
        {
          ok: false,
          agentsDbSource: agentsSource[0],
          error: 'public.ctwa_referrals missing phone_norm or table not found',
          columns: Array.from(columns),
          localLeadRows,
          localLeadError,
        },
        { status: 200, headers: { 'Cache-Control': 'no-store, max-age=0' } }
      )
    }

    const totalSelect = columns.has('created_at')
      ? 'count(*)::int as total, max(created_at)::text as max_created_at'
      : 'count(*)::int as total'
    const [summary] = await agentsSql.unsafe<Row[]>(`
      select ${totalSelect}
      from public.ctwa_referrals
    `)

    const select = selectList(columns)
    const order = orderByCreated(columns)
    const leadLast9s = unique(localLeadRows.map((row) => String(row.phone_last9 ?? '')).filter((v) => v.length >= 9))

    const suffixMatches = await agentsSql.unsafe<Row[]>(`
      select ${select}
      from public.ctwa_referrals c
      where right(regexp_replace(c.phone_norm, '\\D', '', 'g'), 4) in ('1201', '4853', '5830')
      ${order}
      limit 100
    `)

    let exactLast9Matches: Row[] = []
    if (leadLast9s.length > 0) {
      const placeholders = leadLast9s.map((_, index) => `$${index + 1}::text`).join(', ')
      exactLast9Matches = await agentsSql.unsafe<Row[]>(
        `
          select ${select}
          from public.ctwa_referrals c
          where right(regexp_replace(c.phone_norm, '\\D', '', 'g'), 9) in (${placeholders})
          ${order}
          limit 100
        `,
        leadLast9s
      )
    }

    let todaySummary: Row | null = null
    let last24hSummary: Row | null = null
    let recentRows: Row[] = []
    let todayByCampaign: Row[] = []
    let campaignSearchRows: Row[] = []

    if (columns.has('created_at')) {
      ;[todaySummary] = await agentsSql.unsafe<Row[]>(`
        select count(*)::int as count, max(created_at)::text as max_created_at
        from public.ctwa_referrals
        where created_at >= date '${TODAY}'
      `)
      ;[last24hSummary] = await agentsSql.unsafe<Row[]>(`
        select count(*)::int as count, max(created_at)::text as max_created_at
        from public.ctwa_referrals
        where created_at >= now() - interval '24 hours'
      `)

      recentRows = await agentsSql.unsafe<Row[]>(`
        select ${select}
        from public.ctwa_referrals c
        order by c.created_at desc nulls last
        limit 30
      `)

      const groupColumns = [
        'campaign_name',
        'ad_name',
        'account_name',
        'account_id',
        'ad_account_name',
        'ad_account_id',
        'source',
      ].filter((column) => columns.has(column))
      const groupSelect = groupColumns.length
        ? `, ${groupColumns.map((column) => `c.${quoteIdent(column)}`).join(', ')}`
        : ''
      const groupBy = groupColumns.length
        ? `group by ${groupColumns.map((column) => `c.${quoteIdent(column)}`).join(', ')}`
        : ''

      todayByCampaign = await agentsSql.unsafe<Row[]>(`
        select count(*)::int as count, max(c.created_at)::text as last_created_at${groupSelect}
        from public.ctwa_referrals c
        where c.created_at >= date '${TODAY}'
        ${groupBy}
        order by max(c.created_at) desc nulls last
        limit 30
      `)
    } else {
      recentRows = await agentsSql.unsafe<Row[]>(`
        select ${select}
        from public.ctwa_referrals c
        limit 30
      `)
    }

    const searchFields = ['campaign_name', 'ad_name'].filter((column) => columns.has(column))
    if (searchFields.length > 0) {
      const terms = ['Gestor AI', 'Gestor', 'AutonomIA', 'Autonomia', 'Gastão', 'Gastao', 'Casal', 'Tráfego', 'Trafego', 'Nina', 'Agente 24h', 'Agente 24 horas']
      const where = searchFields
        .map((field) => terms.map((_, index) => `c.${quoteIdent(field)} ilike $${index + 1}`).join(' or '))
        .join(' or ')
      campaignSearchRows = await agentsSql.unsafe<Row[]>(
        `
          select ${select}
          from public.ctwa_referrals c
          where ${where}
          ${order}
          limit 100
        `,
        terms.map((term) => `%${term}%`)
      )
    }

    const response = NextResponse.json({
      ok: true,
      probe: PROBE_LABEL,
      generatedAt: new Date().toISOString(),
      agentsDbSource: agentsSource[0],
      ctwaColumns: Array.from(columns),
      localLeadLookup: {
        companyId: 292,
        suffixes: SUFFIXES,
        rows: localLeadRows,
        error: localLeadError,
      },
      summary,
      today: {
        date: TODAY,
        sinceDateCount: todaySummary,
        last24h: last24hSummary,
        byCampaign: todayByCampaign,
      },
      matches: {
        exactByLocalLeadLast9: sanitizeRows(exactLast9Matches),
        suffixOnlyLast4: sanitizeRows(suffixMatches),
      },
      recentRows: sanitizeRows(recentRows),
      campaignSearchRows: sanitizeRows(campaignSearchRows),
    })
    response.headers.set('Cache-Control', 'no-store, max-age=0')
    return response
  } catch (error) {
    return NextResponse.json(
      { ok: false, agentsDbSource: agentsSource[0], error: String(error) },
      { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0' } }
    )
  } finally {
    await agentsSql.end({ timeout: 1 }).catch(() => undefined)
  }
}
