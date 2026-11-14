import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { AuthError, ForbiddenError } from '@/lib/auth'
import { db } from '@/lib/db'
import { isOperatorTableMissing, OperatorAccessError, requireOperatorAdmin } from '@/lib/operator/panel-auth'
import { createOperatorService } from '@/lib/operator/service'
import { sacOperatorJobs } from '@/lib/operator/schema'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const actor = await requireOperatorAdmin()
    const { jobId } = await context.params
    if (!UUID.test(jobId)) return NextResponse.json({ error: 'Job não encontrado.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    await createOperatorService().expireStuck(actor.company.id, jobId)
    const [job] = await db.select().from(sacOperatorJobs).where(and(eq(sacOperatorJobs.companyId, actor.company.id), eq(sacOperatorJobs.id, jobId))).limit(1)
    if (!job) return NextResponse.json({ error: 'Job não encontrado.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    return NextResponse.json({ job }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const status = error instanceof OperatorAccessError ? error.status
      : error instanceof AuthError ? 401
        : error instanceof ForbiddenError ? 403
          : isOperatorTableMissing(error) ? 403
            : typeof error === 'object' && error !== null && 'digest' in error && String((error as { digest?: unknown }).digest).startsWith('NEXT_REDIRECT') ? 401 : 500
    if (status === 500) console.error('[Operador SAC] falha na rota de job', { kind: error instanceof Error ? error.name : 'desconhecido' })
    const message = status === 401 ? 'Sem sessão.' : status === 403 ? 'Operador desligado para esta empresa.' : 'Falha no Operador SAC.'
    return NextResponse.json({ error: error instanceof OperatorAccessError ? error.message : message }, { status, headers: { 'Cache-Control': 'no-store' } })
  }
}
