export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { authenticateAgentRequest } from '@/lib/agent-auth'
import { db } from '@/lib/db'
import { syncCursors } from '@/lib/db/schema'
import { syncAgentsAndCompanies } from '@/lib/sync-agents'

const CURSOR_SOURCE = 'agent_conversations'
const CURSOR_SOURCE_KEY = 'agente24horas'

async function readCursor(companyId: number) {
  const [cursor] = await db
    .select()
    .from(syncCursors)
    .where(and(
      eq(syncCursors.companyId, companyId),
      eq(syncCursors.source, CURSOR_SOURCE),
      eq(syncCursors.sourceKey, CURSOR_SOURCE_KEY),
    ))
    .limit(1)

  return cursor ?? null
}

// Sonda temporária e autenticada do incidente de 23/09/2026. Ela chama a
// mesma função do cron e devolve o report completo junto do cursor antes e
// depois, sem retornar conteúdo de mensagens ou qualquer dado de lead.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error, context } = await authenticateAgentRequest(req, 'autonomia')
  if (error || !context) return error!

  const cursorBefore = await readCursor(context.company.id)
  const report = await syncAgentsAndCompanies()
  const cursorAfter = await readCursor(context.company.id)

  return NextResponse.json({
    ok: report.ok,
    companyId: context.company.id,
    source: CURSOR_SOURCE,
    sourceKey: CURSOR_SOURCE_KEY,
    cursorBefore,
    cursorAfter,
    report,
  })
}
