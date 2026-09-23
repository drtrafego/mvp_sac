import { NextResponse } from 'next/server'
import { requireAdmin, unauthorizedResponse } from '@/lib/auth'
import { db } from '@/lib/db'
import { messageJobs, recoveryLeads } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

// Rota TEMPORÁRIA de diagnóstico (23/09/2026): descobrir o tamanho real da
// fila de message_jobs represada antes de ligar o cron que nunca existiu
// (achado: /api/cron nunca foi chamado por nenhum agendador em 7 dias).
// Só agregado, nenhum dado pessoal de lead. Apaga depois de usar.
export async function GET() {
  try {
    await requireAdmin()
  } catch {
    return unauthorizedResponse()
  }

  const porStatus = await db
    .select({ status: messageJobs.status, n: sql<number>`COUNT(*)::int` })
    .from(messageJobs)
    .groupBy(messageJobs.status)

  const [atrasados] = await db
    .select({
      n: sql<number>`COUNT(*)::int`,
      maisAntigo: sql<string>`MIN(${messageJobs.scheduledFor})`,
      maisRecente: sql<string>`MAX(${messageJobs.scheduledFor})`,
    })
    .from(messageJobs)
    .where(sql`${messageJobs.status} = 'pending' AND ${messageJobs.scheduledFor} < now()`)

  const porEmpresa = await db
    .select({
      companyId: recoveryLeads.companyId,
      n: sql<number>`COUNT(*)::int`,
      maisAntigo: sql<string>`MIN(${messageJobs.scheduledFor})`,
    })
    .from(messageJobs)
    .innerJoin(recoveryLeads, eq(messageJobs.leadId, recoveryLeads.id))
    .where(sql`${messageJobs.status} = 'pending' AND ${messageJobs.scheduledFor} < now()`)
    .groupBy(recoveryLeads.companyId)

  return NextResponse.json({ porStatus, atrasadosVencidos: atrasados, porEmpresaAtrasados: porEmpresa })
}
