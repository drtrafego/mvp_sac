import { NextRequest, NextResponse } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/lib/db'
import { companies, sacAuditEvents, sacCodexJobs } from '@/lib/db/schema'
import { createInstagramMediaComment, replyInstagramCommentPublic } from '@/lib/instagram'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ idOrSlug: string }> }

function executorKeyMatches(req: NextRequest): boolean {
  const expected = process.env.SAC_CODEX_EXECUTOR_KEY?.trim()
  const supplied = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  return Boolean(expected && supplied && supplied === expected)
}

export async function POST(req: NextRequest, { params }: Params) {
  if (!executorKeyMatches(req)) return NextResponse.json({ error: 'Executor Codex não autenticado.', code: 'UNAUTHORIZED' }, { status: 401 })
  if (req.headers.get('x-codex-confirmed') !== 'true') return NextResponse.json({ error: 'Ação externa exige confirmação do Codex.', code: 'CONFIRMATION_REQUIRED' }, { status: 409 })

  const { idOrSlug } = await params
  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  const jobId = typeof body?.jobId === 'string' ? body.jobId.trim() : ''
  const mediaId = typeof body?.mediaId === 'string' ? body.mediaId.trim() : ''
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!jobId || !mediaId || !text) return NextResponse.json({ error: 'jobId, mediaId e text são obrigatórios.' }, { status: 400 })

  const isNumeric = /^\d+$/.test(idOrSlug)
  const [company] = await db.select({ id: companies.id }).from(companies).where(isNumeric ? eq(companies.id, Number(idOrSlug)) : eq(companies.slug, idOrSlug)).limit(1)
  if (!company) return NextResponse.json({ error: 'Tenant não encontrado.', code: 'TENANT_NOT_FOUND' }, { status: 404 })
  const [job] = await db.select().from(sacCodexJobs).where(and(eq(sacCodexJobs.jobId, jobId), eq(sacCodexJobs.companyId, company.id))).limit(1)
  if (!job) return NextResponse.json({ error: 'Job inexistente ou fora do tenant autorizado.', code: 'TENANT_MISMATCH' }, { status: 404 })
  if (job.intent !== 'instagram.comment.create' && job.intent !== 'instagram.comment.reply') return NextResponse.json({ error: 'Ação fora da allowlist do executor SAC.', code: 'ACTION_NOT_ALLOWLISTED' }, { status: 403 })
  if (job.mediaId !== mediaId || job.targetText !== text) return NextResponse.json({ error: 'O payload não corresponde ao job original.', code: 'PAYLOAD_MISMATCH' }, { status: 409 })
  const jobContext = job.context && typeof job.context === 'object' && !Array.isArray(job.context) ? job.context as Record<string, unknown> : {}
  const commentId = typeof body?.commentId === 'string' ? body.commentId.trim() : ''
  if (job.intent === 'instagram.comment.reply' && (!commentId || jobContext.commentId !== commentId)) {
    return NextResponse.json({ error: 'commentId não corresponde ao evento original.', code: 'COMMENT_PAYLOAD_MISMATCH' }, { status: 409 })
  }
  if (job.status === 'concluido') return NextResponse.json({ ok: true, reused: true, result: job.result })
  if (job.status !== 'executando') return NextResponse.json({ error: `Job está em ${job.status}; publicação bloqueada.`, code: 'INVALID_JOB_STATE' }, { status: 409 })

  // Claim atômico antes da chamada externa: retries concorrentes do gateway
  // não podem publicar duas vezes o mesmo job. Em timeout, o job fica travado
  // para revisão porque a API externa pode ter aceitado a operação.
  const [claimed] = await db.update(sacCodexJobs)
    .set({ executionClaimedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(sacCodexJobs.id, job.id), eq(sacCodexJobs.status, 'executando'), isNull(sacCodexJobs.executionClaimedAt)))
    .returning()
  if (!claimed) return NextResponse.json({ error: 'Ação já está em execução ou foi concluída.', code: 'ACTION_ALREADY_CLAIMED' }, { status: 409 })

  const result = job.intent === 'instagram.comment.reply'
    ? await replyInstagramCommentPublic({ companyId: job.companyId, mediaId, commentId, text })
    : await createInstagramMediaComment({ companyId: job.companyId, mediaId, text })
  const nextStatus = result.ok ? 'concluido' : 'erro'
  const [updated] = await db.update(sacCodexJobs).set({ status: nextStatus, result, errorMessage: result.ok ? null : result.error?.slice(0, 500), updatedAt: new Date(), completedAt: result.ok ? new Date() : null }).where(and(eq(sacCodexJobs.id, job.id), eq(sacCodexJobs.status, 'executando'))).returning()
  const publishedCommentId = 'commentId' in result ? result.commentId ?? null : null
  await db.insert(sacAuditEvents).values({ companyId: job.companyId, actorType: 'system', actorId: 'codex', type: result.ok ? (job.intent === 'instagram.comment.reply' ? 'instagram_comment_reply_published' : 'instagram_comment_published') : 'instagram_comment_failed', referenceType: 'codex_job', referenceId: jobId, payload: { mediaId, commentId: job.intent === 'instagram.comment.reply' ? commentId : publishedCommentId, replyId: 'replyId' in result ? result.replyId ?? null : null, permalink: 'permalink' in result ? result.permalink ?? null : null, error: result.error ?? null, uncertain: result.uncertain ?? false } })
  return NextResponse.json({ ok: result.ok, status: nextStatus, result, job: updated }, { status: result.ok ? 200 : (result.uncertain ? 504 : 502) })
}
