import { createHash, randomUUID } from 'node:crypto'
import { and, eq, gte, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { sacAuditEvents, sacCodexJobs } from '@/lib/db/schema'

export const LUANA_COMMENT_TRIGGER = 'Luana'
export const APPROVED_LUANA_COMMENT_REPLY = 'Quer implementar a Luana na sua empresa? Na consultoria, vamos entender sua rotina e identificar quais tarefas ela pode assumir pra ajudar sua equipe no dia a dia. Nossa equipe vai entrar em contato com você pra marcar o melhor horário. Topa??'
export const INSTAGRAM_COMMENT_JOB_INTENT = 'instagram.comment.reply'
export const MAX_LUANA_COMMENT_JOBS_PER_HOUR = 60
export const MAX_LUANA_COMMENT_EVENTS_PER_BATCH = 100

export type LuanaCommentEvent = {
  companyId: number
  entryAccountId: string
  acceptedAccountIds: readonly string[]
  commentId: string
  commenterId: string
  commenterUsername?: string
  mediaId: string
  commentText: string
}

export type EligibleLuanaCommentEvent = LuanaCommentEvent & {
  entryAccountId: string
  mediaId: string
}

export type LuanaCommentPreparationResult = {
  handled: boolean
  status: 'prepared' | 'duplicate' | 'rate_limited' | 'blocked'
  jobId?: string
  mediaId?: string
  reason?: string
}

type Database = typeof db

function normalizedIds(ids: readonly string[]): string[] {
  return ids.map(id => id.trim()).filter(Boolean)
}

export function isLuanaTriggerComment(commentText: string): boolean {
  return /\bluana\b/iu.test(commentText)
}

export function isEligibleLuanaCommentEvent(event: LuanaCommentEvent): { eligible: true; event: EligibleLuanaCommentEvent } | { eligible: false; reason: string } {
  if (!Number.isInteger(event.companyId) || event.companyId <= 0) return { eligible: false, reason: 'tenant_invalido' }
  const entryAccountId = event.entryAccountId.trim()
  if (!entryAccountId || !normalizedIds(event.acceptedAccountIds).includes(entryAccountId)) return { eligible: false, reason: 'conta_fora_do_tenant' }
  if (!event.commentId.trim()) return { eligible: false, reason: 'comment_id_ausente' }
  if (!event.commenterId.trim()) return { eligible: false, reason: 'autor_ausente' }
  const mediaId = event.mediaId.trim()
  if (!/^\d+$/.test(mediaId)) return { eligible: false, reason: 'media_id_invalido' }
  if (!isLuanaTriggerComment(event.commentText)) return { eligible: false, reason: 'gatilho_ausente' }

  return {
    eligible: true,
    event: {
      ...event,
      entryAccountId,
      commentId: event.commentId.trim(),
      commenterId: event.commenterId.trim(),
      mediaId,
      commentText: event.commentText.trim(),
    },
  }
}

/**
 * Mantém a enumeração baseada somente nos eventos oficiais recebidos. Não há
 * fallback para URL, scraping ou ID gerado localmente. O retorno também
 * explicita as mídias cobertas pelo lote para a auditoria do chamador.
 */
export function enumerateEligibleLuanaCommentEvents(
  events: readonly LuanaCommentEvent[],
  maxEvents = MAX_LUANA_COMMENT_EVENTS_PER_BATCH,
): { events: EligibleLuanaCommentEvent[]; mediaIds: string[]; skipped: Array<{ commentId: string; reason: string }> } {
  const selected: EligibleLuanaCommentEvent[] = []
  const mediaIds = new Set<string>()
  const seenComments = new Set<string>()
  const skipped: Array<{ commentId: string; reason: string }> = []

  for (const event of events) {
    const result = isEligibleLuanaCommentEvent(event)
    if (!result.eligible) {
      if (isLuanaTriggerComment(event.commentText)) skipped.push({ commentId: event.commentId.trim(), reason: result.reason })
      continue
    }
    const dedupKey = `${result.event.companyId}:${result.event.commentId}`
    if (seenComments.has(dedupKey)) {
      skipped.push({ commentId: result.event.commentId, reason: 'comment_duplicado_no_lote' })
      continue
    }
    if (selected.length >= maxEvents) {
      skipped.push({ commentId: result.event.commentId, reason: 'limite_do_lote' })
      continue
    }
    seenComments.add(dedupKey)
    selected.push(result.event)
    mediaIds.add(result.event.mediaId)
  }

  return { events: selected, mediaIds: [...mediaIds], skipped }
}

export function luanaCommentIdempotencyKey(companyId: number, commentId: string): string {
  return createHash('sha256').update(`instagram-luana-comment|${companyId}|${commentId.trim()}`).digest('hex')
}

function safeTranscript(commentId: string): string {
  return `Evento oficial de comentário do Instagram ${commentId}; gatilho "${LUANA_COMMENT_TRIGGER}"; resposta aprovada preparada.`
}

async function audit(database: Database, companyId: number, type: string, referenceId: string, payload: Record<string, unknown>) {
  await database.insert(sacAuditEvents).values({
    companyId,
    actorType: 'system',
    actorId: 'instagram-webhook',
    type,
    referenceType: 'instagram_comment_event',
    referenceId,
    payload,
  })
}

/**
 * Prepara um job aguardando confirmação humana. Esta função deliberadamente
 * não lê credencial, não chama a Graph API e não tenta publicar.
 */
export async function prepareLuanaCommentJob(input: LuanaCommentEvent, database: Database = db): Promise<LuanaCommentPreparationResult> {
  const eligible = isEligibleLuanaCommentEvent(input)
  const isTrigger = isLuanaTriggerComment(input.commentText)
  if (!isTrigger) return { handled: false, status: 'blocked', reason: 'gatilho_ausente' }
  if (!eligible.eligible) {
    if (!Number.isInteger(input.companyId) || input.companyId <= 0) {
      return { handled: true, status: 'blocked', reason: eligible.reason }
    }
    await audit(database, input.companyId, 'instagram_luana_comment_blocked', input.commentId.trim() || 'unknown', {
      reason: eligible.reason,
      mediaId: input.mediaId.trim() || null,
      accountId: input.entryAccountId.trim() || null,
    })
    return { handled: true, status: 'blocked', reason: eligible.reason }
  }

  const event = eligible.event
  const idempotencyKey = luanaCommentIdempotencyKey(event.companyId, event.commentId)
  const [existing] = await database
    .select({ jobId: sacCodexJobs.jobId, mediaId: sacCodexJobs.mediaId })
    .from(sacCodexJobs)
    .where(and(eq(sacCodexJobs.companyId, event.companyId), eq(sacCodexJobs.idempotencyKey, idempotencyKey)))
    .limit(1)
  if (existing) return { handled: true, status: 'duplicate', jobId: existing.jobId, mediaId: existing.mediaId ?? event.mediaId }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const [recent] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(sacCodexJobs)
    .where(and(
      eq(sacCodexJobs.companyId, event.companyId),
      eq(sacCodexJobs.intent, INSTAGRAM_COMMENT_JOB_INTENT),
      gte(sacCodexJobs.createdAt, oneHourAgo),
    ))
  if (Number(recent?.count ?? 0) >= MAX_LUANA_COMMENT_JOBS_PER_HOUR) {
    await audit(database, event.companyId, 'instagram_luana_comment_rate_limited', event.commentId, {
      mediaId: event.mediaId,
      limitPerHour: MAX_LUANA_COMMENT_JOBS_PER_HOUR,
    })
    return { handled: true, status: 'rate_limited', mediaId: event.mediaId, reason: 'limite_por_hora' }
  }

  const jobId = randomUUID()
  const now = new Date()
  const [job] = await database.insert(sacCodexJobs).values({
    jobId,
    companyId: event.companyId,
    idempotencyKey,
    sessionId: `instagram-webhook:${event.companyId}`,
    actorId: 'instagram-webhook',
    inputKind: 'event',
    transcript: safeTranscript(event.commentId),
    intent: INSTAGRAM_COMMENT_JOB_INTENT,
    targetText: APPROVED_LUANA_COMMENT_REPLY,
    mediaId: event.mediaId,
    context: {
      source: 'instagram_comment_event',
      commentId: event.commentId,
      commenterId: event.commenterId,
      commenterUsername: event.commenterUsername?.trim() || null,
      entryAccountId: event.entryAccountId,
      trigger: LUANA_COMMENT_TRIGGER,
      executionBlockedUntilCredential: true,
    },
    status: 'aguardando_confirmacao',
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing({ target: [sacCodexJobs.companyId, sacCodexJobs.idempotencyKey] }).returning({ jobId: sacCodexJobs.jobId })

  if (!job) {
    const [raced] = await database.select({ jobId: sacCodexJobs.jobId }).from(sacCodexJobs)
      .where(and(eq(sacCodexJobs.companyId, event.companyId), eq(sacCodexJobs.idempotencyKey, idempotencyKey))).limit(1)
    return { handled: true, status: 'duplicate', jobId: raced?.jobId, mediaId: event.mediaId }
  }

  await audit(database, event.companyId, 'instagram_luana_comment_job_prepared', job.jobId, {
    commentId: event.commentId,
    mediaId: event.mediaId,
    intent: INSTAGRAM_COMMENT_JOB_INTENT,
    status: 'aguardando_confirmacao',
    humanConfirmationRequired: true,
    executionBlockedUntilCredential: true,
  })
  return { handled: true, status: 'prepared', jobId: job.jobId, mediaId: event.mediaId }
}
