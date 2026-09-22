export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'

const PROBE_KEY = 'UYeOTTR0YpNos726TKQwTQ5x2ughxg8qpl39LIKdJ50'

function envInfo(name: string) {
  const value = process.env[name] ?? ''
  return {
    present: Boolean(value),
    length: value.length,
    prefix: value ? value.slice(0, 4) : '',
    suffix: value ? value.slice(-4) : '',
  }
}

export async function GET(req: NextRequest) {
  if (req.headers.get('x-probe-key') !== PROBE_KEY) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store, max-age=0' } }
    )
  }

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    return NextResponse.json(
      { ok: false, error: 'DATABASE_URL missing' },
      { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0' } }
    )
  }

  const sql = neon(databaseUrl)
  const companies = await sql`
    select id, name, slug
    from companies
    where slug ilike '%gramado%' or name ilike '%gramado%'
    order by id
  `

  const hermes = process.env.HERMES_WEBHOOK_SECRET ?? ''
  const sac = process.env.SAC_WEBHOOK_SECRET ?? ''
  const selectedSource = hermes ? 'HERMES_WEBHOOK_SECRET' : (sac ? 'SAC_WEBHOOK_SECRET' : null)
  const selectedToken = hermes || sac || ''

  return NextResponse.json(
    {
      ok: true,
      companies,
      env: {
        HERMES_WEBHOOK_SECRET: envInfo('HERMES_WEBHOOK_SECRET'),
        SAC_WEBHOOK_SECRET: envInfo('SAC_WEBHOOK_SECRET'),
      },
      selectedSource,
      selectedToken,
    },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } }
  )
}
