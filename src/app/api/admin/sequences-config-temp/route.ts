import { NextResponse } from 'next/server'
import { requireAdmin, unauthorizedResponse } from '@/lib/auth'
import { db } from '@/lib/db'
import { companies, recoverySequences, sequenceMessages } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

// Rota TEMPORÁRIA de diagnóstico (23/09/2026): pra cada empresa, quais
// sequências de recuperação existem, se estão ativas e quantas mensagens
// ativas cada uma tem. Só nome de empresa (não é PII de lead/cliente final).
// Motivo: message_jobs está zerado em produção; isto confirma se é porque
// ninguém cadastrou conteúdo, ou outra causa. Apaga depois de usar.
export async function GET() {
  try {
    await requireAdmin()
  } catch {
    return unauthorizedResponse()
  }

  const rows = await db
    .select({
      companyId: companies.id,
      companyName: companies.name,
      eventType: recoverySequences.eventType,
      sequenceId: recoverySequences.id,
      isActive: recoverySequences.isActive,
      mensagensAtivas: sql<number>`COALESCE((
        SELECT COUNT(*)::int FROM ${sequenceMessages}
        WHERE ${sequenceMessages.sequenceId} = ${recoverySequences.id}
        AND ${sequenceMessages.isActive} = true
      ), 0)`,
    })
    .from(companies)
    .leftJoin(recoverySequences, eq(recoverySequences.companyId, companies.id))
    .orderBy(companies.id, recoverySequences.eventType)

  return NextResponse.json({ rows })
}
