import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sql } from 'drizzle-orm'

const DIAG_KEY = 'c2e8f1a6d9b4530ce7fa92b18d6e7c0a1f3b5d9'

export async function GET(req: NextRequest) {
  const key = req.headers.get('x-diag-key') || req.nextUrl.searchParams.get('key')
  if (key !== DIAG_KEY) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  try {
    const logs = await db.execute(sql`
      select id, automation_id, status, media_id, commenter_id, created_at
      from instagram_comment_logs
      where automation_id = 5
      order by created_at desc
      limit 10
    `)

    const webhooks = await db.execute(sql`
      select id, event, processed, skip_reason, error_message, received_at
      from webhook_received
      where company_id = 292 and source = 'instagram'
      order by received_at desc
      limit 10
    `)

    const automation = await db.execute(sql`
      select id, is_active, total_triggered from instagram_comment_automations where id = 5
    `)

    return NextResponse.json({
      ok: true,
      now: new Date().toISOString(),
      automation: automation.rows?.[0] ?? null,
      logs_automacao_5: logs.rows ?? [],
      ultimos_webhooks_instagram_autonomia: webhooks.rows ?? [],
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
