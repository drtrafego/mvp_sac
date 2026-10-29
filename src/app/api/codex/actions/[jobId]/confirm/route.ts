import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { sacAuditEvents, sacCodexJobs } from '@/lib/db/schema'
import { requireSacActor } from '@/lib/auth'
import { confirmCodexGatewayJob } from '@/lib/codex-gateway-client'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const actor = await requireSacActor()
  const { jobId } = await params
  const [job] = await db.select().from(sacCodexJobs).where(and(eq(sacCodexJobs.companyId, actor.company.id), eq(sacCodexJobs.jobId, jobId))).limit(1)
  if (!job) return NextResponse.json({ error: 'Job não encontrado neste tenant.' }, { status: 404 })
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  if (body.confirm !== true) return NextResponse.json({ error: 'A confirmação precisa ser explícita.' }, { status: 400 })
  if (job.status !== 'aguardando_confirmacao') return NextResponse.json({ error: `Job está em ${job.status} e não aceita confirmação.` }, { status: 409 })

  const jobContext = job.context && typeof job.context === 'object' && !Array.isArray(job.context) ? job.context as Record<string, unknown> : {}
  if (jobContext.source === 'instagram_comment_event') {
    const [updated] = await db.update(sacCodexJobs).set({ status: 'executando', errorMessage: null, confirmedAt: new Date(), updatedAt: new Date() }).where(and(eq(sacCodexJobs.companyId, actor.company.id), eq(sacCodexJobs.jobId, jobId))).returning()
    await db.insert(sacAuditEvents).values({ companyId: actor.company.id, actorType: 'human', actorId: actor.actorId, type: 'codex_job_confirmed', referenceType: 'codex_job', referenceId: jobId, payload: { status: 'executando', source: 'instagram_comment_event', executionBlockedUntilCredential: true } })
    return NextResponse.json({ ok: true, job: updated })
  }

  try {
    const response = await confirmCodexGatewayJob({ jobId, tenant: { id: actor.company.id, slug: actor.company.slug }, sessionId: job.sessionId, confirmation: true })
    const status = typeof response.status === 'string' ? response.status : 'executando'
    const [updated] = await db.update(sacCodexJobs).set({ status, result: response.result ?? job.result, errorMessage: null, confirmedAt: new Date(), updatedAt: new Date() }).where(and(eq(sacCodexJobs.companyId, actor.company.id), eq(sacCodexJobs.jobId, jobId))).returning()
    await db.insert(sacAuditEvents).values({ companyId: actor.company.id, actorType: 'human', actorId: actor.actorId, type: 'codex_job_confirmed', referenceType: 'codex_job', referenceId: jobId, payload: { status } })
    return NextResponse.json({ ok: true, job: updated })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao confirmar no gateway Codex.'
    const [updated] = await db.update(sacCodexJobs).set({ status: 'erro', errorMessage: message.slice(0, 500), updatedAt: new Date() }).where(and(eq(sacCodexJobs.companyId, actor.company.id), eq(sacCodexJobs.jobId, jobId))).returning()
    return NextResponse.json({ ok: false, error: message, job: updated }, { status: 502 })
  }
}
