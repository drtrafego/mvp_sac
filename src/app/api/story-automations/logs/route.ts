import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireCompany, AuthError } from '@/lib/auth'
import { sql } from 'drizzle-orm'
import { isStoryTriggerEnabledForSlug } from '@/lib/instagram-story-automation'

export async function GET(request: NextRequest) {
  try {
    const company = await requireCompany(); if (!isStoryTriggerEnabledForSlug(company.slug)) return NextResponse.json({ error: 'Disponível apenas para a conta piloto.' }, { status: 403 }); const id = request.nextUrl.searchParams.get('automationId')
    const automationId = id && /^\d+$/.test(id) ? Number(id) : null
    const result = await db.execute(sql`SELECT d.id, d.automation_id AS "automationId", a.name AS "automationName", d.sender_id AS "senderId", d.story_id AS "storyId", d.message_mid AS "messageMid", d.occurred_at AS "occurredAt", d.status, d.reason, d.outbound_message_id AS "outboundMessageId", d.created_at AS "createdAt" FROM instagram_story_deliveries d LEFT JOIN instagram_story_automations a ON a.id = d.automation_id WHERE d.company_id = ${company.id} AND (${automationId}::integer IS NULL OR d.automation_id = ${automationId}) ORDER BY d.created_at DESC LIMIT 100`)
    return NextResponse.json({ logs: Array.isArray(result) ? result : result.rows ?? [] })
  } catch (error) { if (error instanceof AuthError || (typeof error === 'object' && error !== null && 'status' in error && error.status === 401)) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 }); console.error(`[Story Automations Logs] name=${error instanceof Error ? error.name : 'ErroDesconhecido'}`); return NextResponse.json({ error: 'Não foi possível carregar o histórico.' }, { status: 500 }) }
}
