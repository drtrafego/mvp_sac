import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { neon } from '@neondatabase/serverless'

export const dynamic = 'force-dynamic'

type DuplicateLeadRow = {
  company_id: number
  phone: string
  duplicate_count: number
  id: number
  name: string | null
  created_at: Date | string | null
  updated_at: Date | string | null
  messages_count: number
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function checkDiagKey(req: NextRequest): { ok: true } | { ok: false; status: 401 | 503 } {
  const secret = process.env.OPS_DIAG_DUPLICADOS_KEY?.trim()
  if (!secret) return { ok: false, status: 503 }

  const provided = req.nextUrl.searchParams.get('key')
  if (!provided || !safeEqual(provided, secret)) return { ok: false, status: 401 }

  return { ok: true }
}

function toJsonDate(value: Date | string | null): string | null {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : value
}

export async function GET(req: NextRequest) {
  const keyCheck = checkDiagKey(req)
  if (!keyCheck.ok) {
    const message =
      keyCheck.status === 503
        ? 'Rota desativada: OPS_DIAG_DUPLICADOS_KEY nao configurada.'
        : 'Acesso restrito ao administrador'
    return NextResponse.json({ error: message }, { status: keyCheck.status })
  }

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    return NextResponse.json({ error: 'DATABASE_URL nao configurada.' }, { status: 503 })
  }

  const sql = neon(databaseUrl)
  const rows = await sql`
    WITH duplicate_groups AS (
      SELECT company_id, phone, count(*)::int AS duplicate_count
      FROM recovery_leads
      WHERE platform IN ('instagram','sac','hermes')
      GROUP BY company_id, phone
      HAVING count(*) > 1
    ),
    message_counts AS (
      SELECT lead_id, count(*)::int AS messages_count
      FROM whatsapp_messages
      WHERE lead_id IS NOT NULL
      GROUP BY lead_id
    )
    SELECT
      dg.company_id,
      dg.phone,
      dg.duplicate_count,
      rl.id,
      rl.name,
      rl.created_at,
      rl.updated_at,
      COALESCE(mc.messages_count, 0)::int AS messages_count
    FROM duplicate_groups dg
    JOIN recovery_leads rl
      ON rl.company_id = dg.company_id
      AND rl.phone = dg.phone
      AND rl.platform IN ('instagram','sac','hermes')
    LEFT JOIN message_counts mc
      ON mc.lead_id = rl.id
    ORDER BY dg.company_id, dg.phone, rl.id
  ` as DuplicateLeadRow[]

  const groups = rows.reduce<Array<{
    company_id: number
    phone: string
    duplicate_count: number
    leads: Array<{
      id: number
      name: string | null
      createdAt: string | null
      updatedAt: string | null
      messagesCount: number
    }>
  }>>((acc, row) => {
    let group = acc.find(item => item.company_id === row.company_id && item.phone === row.phone)
    if (!group) {
      group = {
        company_id: row.company_id,
        phone: row.phone,
        duplicate_count: row.duplicate_count,
        leads: [],
      }
      acc.push(group)
    }

    group.leads.push({
      id: row.id,
      name: row.name,
      createdAt: toJsonDate(row.created_at),
      updatedAt: toJsonDate(row.updated_at),
      messagesCount: row.messages_count,
    })

    return acc
  }, [])

  return NextResponse.json({
    ok: true,
    totalDuplicateGroups: groups.length,
    groups,
  })
}
