import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import {
  massDispatchBatches,
  messageJobs,
  metaMessageTemplates,
  recoveryLeads,
  sacAuditEvents,
  whatsappMessages,
} from '@/lib/db/schema'
import { POST as runDispatchCron, ISABELLA_QUIZ_AUTHORIZED_EXCEPTION_JOB_TYPE } from '@/app/api/cron/route'

const QUIZ_BATCH_ID = 35
const QUIZ_COMPANY_ID = 2
const QUIZ_COMPANY_SLUG = 'isabela-fanini'
const CANCELLED_JOB_IDS = [156, 160, 176, 254] as const
// These six jobs have a provider status of failed and a WAMID. They are a
// separate, fixed allowlist from the lease failures: a lease without a WAMID
// is never eligible for this route because Meta acceptance is unknown.
const FAILED_JOB_IDS = [174, 183, 186, 188, 190, 191] as const
const EXCEPTION_JOB_IDS = [...CANCELLED_JOB_IDS, ...FAILED_JOB_IDS] as const
const EXCEPTION_SCOPE = 'quiz_isabella_batch_35'
const EXCEPTION_REFERENCE_TYPE = 'quiz_isabella_batch_35_original_job'

function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, '')
}

function idempotencyKey(jobId: number): string {
  return `${EXCEPTION_SCOPE}:original-job:${jobId}`
}

function exceptionMessageSnapshot(batch: {
  templateName: string | null
  templateLanguage: string | null
  templateVariablesMap: unknown
  templateSnapshot: unknown
}) {
  const canonical = batch.templateSnapshot as { bodyText?: unknown } | null
  return {
    messageType: 'template',
    content: typeof canonical?.bodyText === 'string' ? canonical.bodyText : null,
    mediaUrl: null,
    caption: null,
    buttonsJson: null,
    templateName: batch.templateName,
    templateLanguage: batch.templateLanguage,
    templateVariablesMap: batch.templateVariablesMap,
    templateSnapshot: batch.templateSnapshot,
    source: 'quiz_isabella_authorized_exception',
  }
}

function responseJob(job: { id: number; leadId: number | null; status: string | null; externalWamid: string | null; idempotencyKey: string | null }, phone: string) {
  return {
    jobId: job.id,
    leadId: job.leadId,
    status: job.status,
    hasWamid: Boolean(job.externalWamid),
    idempotencyKey: job.idempotencyKey,
    phoneHash: createHash('sha256').update(phoneDigits(phone)).digest('hex'),
  }
}

export async function POST(req: NextRequest, context: { params: Promise<{ batchId: string }> }): Promise<NextResponse> {
  const company = await requireCompany()
  const { batchId: rawBatchId } = await context.params
  if (rawBatchId !== String(QUIZ_BATCH_ID) || company.id !== QUIZ_COMPANY_ID || company.slug !== QUIZ_COMPANY_SLUG) {
    return NextResponse.json({ error: 'Exceção não disponível para este lote ou empresa' }, { status: 404 })
  }

  const body: unknown = await req.json().catch(() => null)
  if (body != null && (typeof body !== 'object' || Array.isArray(body))) {
    return NextResponse.json({ error: 'Corpo inválido' }, { status: 400 })
  }

  const [batch] = await db.select({
    id: massDispatchBatches.id,
    companyId: massDispatchBatches.companyId,
    templateName: massDispatchBatches.templateName,
    templateLanguage: massDispatchBatches.templateLanguage,
    templateVariablesMap: massDispatchBatches.templateVariablesMap,
    templateSnapshot: massDispatchBatches.templateSnapshot,
  }).from(massDispatchBatches).where(and(
    eq(massDispatchBatches.id, QUIZ_BATCH_ID),
    eq(massDispatchBatches.companyId, company.id),
  )).limit(1)
  if (!batch || batch.templateName !== 'coringa_bela_contexto_atendimento_v2' || batch.templateLanguage !== 'pt_BR' || !batch.templateSnapshot) {
    return NextResponse.json({ error: 'Snapshot do lote #35 não corresponde à coringa aprovada' }, { status: 409 })
  }

  const [approvedTemplate] = await db.select({ status: metaMessageTemplates.status, category: metaMessageTemplates.category }).from(metaMessageTemplates).where(and(
    eq(metaMessageTemplates.companyId, company.id),
    eq(metaMessageTemplates.name, 'coringa_bela_contexto_atendimento_v2'),
    eq(metaMessageTemplates.language, 'pt_BR'),
  )).limit(1)
  if (approvedTemplate?.status !== 'APPROVED' || approvedTemplate.category !== 'UTILITY') {
    return NextResponse.json({ error: 'A coringa não está APPROVED/UTILITY no cadastro do SAC' }, { status: 409 })
  }

  const originalJobs = await db.select({
    jobId: messageJobs.id,
    leadId: messageJobs.leadId,
    status: messageJobs.status,
    externalWamid: messageJobs.externalWamid,
    deliveryStatus: messageJobs.deliveryStatus,
    idempotencyKey: messageJobs.idempotencyKey,
    error: messageJobs.error,
    phone: recoveryLeads.phone,
    consent: recoveryLeads.whatsappConsentStatus,
  }).from(messageJobs).innerJoin(recoveryLeads, eq(recoveryLeads.id, messageJobs.leadId)).where(and(
    eq(messageJobs.massDispatchBatchId, QUIZ_BATCH_ID),
    eq(recoveryLeads.companyId, company.id),
    inArray(messageJobs.id, [...EXCEPTION_JOB_IDS]),
  ))
  if (originalJobs.length !== EXCEPTION_JOB_IDS.length) {
    return NextResponse.json({ error: 'Os jobs fixos da exceção do Quiz não foram encontrados integralmente' }, { status: 409 })
  }

  const existingKeys = EXCEPTION_JOB_IDS.map(idempotencyKey)
  const existing = await db.select({
    id: messageJobs.id,
    leadId: messageJobs.leadId,
    status: messageJobs.status,
    externalWamid: messageJobs.externalWamid,
    deliveryStatus: messageJobs.deliveryStatus,
    idempotencyKey: messageJobs.idempotencyKey,
    error: messageJobs.error,
    phone: recoveryLeads.phone,
  }).from(messageJobs).innerJoin(recoveryLeads, eq(recoveryLeads.id, messageJobs.leadId)).where(and(
    eq(recoveryLeads.companyId, company.id),
    inArray(messageJobs.idempotencyKey, existingKeys),
  ))
  const existingByKey = new Map(existing.map(job => [job.idempotencyKey!, job]))

  const targetPhones = originalJobs.map(job => phoneDigits(job.phone))
  const outboundHistory = targetPhones.length > 0
    ? await db.select({ phone: whatsappMessages.phone, leadId: whatsappMessages.leadId, externalId: whatsappMessages.externalId }).from(whatsappMessages).where(and(
      eq(whatsappMessages.companyId, company.id),
      eq(whatsappMessages.direction, 'outbound'),
      or(...targetPhones.map(phone => sql`regexp_replace(${whatsappMessages.phone}, '[^0-9]', '', 'g') = ${phone}`))!,
    ))
    : []
  const failedOriginalWamids = new Set(originalJobs
    .filter(job => job.status === 'sent' && job.deliveryStatus === 'failed' && job.externalWamid)
    .map(job => job.externalWamid!))
  const outboundPhones = new Set(outboundHistory
    .filter(row => !row.externalId || !failedOriginalWamids.has(row.externalId))
    .map(row => phoneDigits(row.phone)))

  const results: Array<Record<string, unknown>> = []
  const skipped: Array<Record<string, unknown>> = []
  const claimable = [] as typeof originalJobs
  const claimablePhones = new Set<string>()
  for (const original of originalJobs) {
    const key = idempotencyKey(original.jobId)
    const existingJob = existingByKey.get(key)
    if (existingJob) {
      if (existingJob.status === 'failed' && existingJob.error === 'Snapshot de lote inválido: template obrigatório com nome' && !existingJob.externalWamid) {
        await db.update(messageJobs).set({
          status: 'pending',
          error: null,
          processingStartedAt: null,
          messageSnapshot: exceptionMessageSnapshot(batch),
        }).where(and(eq(messageJobs.id, existingJob.id), eq(messageJobs.status, 'failed'), eq(messageJobs.idempotencyKey, key)))
        results.push(responseJob({ ...existingJob, status: 'pending' }, existingJob.phone))
      } else {
        results.push(responseJob(existingJob, existingJob.phone))
      }
      continue
    }
    const isCancelledOriginal = original.status === 'cancelled' && !original.externalWamid && !original.deliveryStatus
    const isFailedOriginal = original.status === 'sent' && original.deliveryStatus === 'failed' && Boolean(original.externalWamid)
    if (!isCancelledOriginal && !isFailedOriginal) {
      skipped.push({ jobId: original.jobId, reason: 'original_job_state_not_eligible', hasWamid: Boolean(original.externalWamid), deliveryStatus: original.deliveryStatus })
      continue
    }
    if (isCancelledOriginal && original.externalWamid) {
      skipped.push({ jobId: original.jobId, reason: 'original_job_has_wamid', hasWamid: true })
      continue
    }
    if (original.consent === 'opted_out') {
      skipped.push({ jobId: original.jobId, reason: 'opted_out' })
      continue
    }
    const normalizedPhone = phoneDigits(original.phone)
    if (!normalizedPhone || outboundPhones.has(normalizedPhone)) {
      skipped.push({ jobId: original.jobId, reason: normalizedPhone ? 'existing_outbound_history' : 'missing_phone' })
      continue
    }
    if (claimablePhones.has(normalizedPhone)) {
      skipped.push({ jobId: original.jobId, reason: 'duplicate_phone_in_exception_scope' })
      continue
    }
    claimable.push(original)
    claimablePhones.add(normalizedPhone)
  }

  for (const original of claimable) {
    const key = idempotencyKey(original.jobId)
    const normalizedPhone = phoneDigits(original.phone)

    await db.insert(sacAuditEvents).values({
      companyId: company.id,
      leadId: original.leadId,
      type: 'mass_dispatch_exception_authorized',
      actorType: 'human',
      actorId: 'gastao-quiz-isabella-2026-11-27',
      actorName: 'Autorização específica do Gastão',
      referenceType: EXCEPTION_REFERENCE_TYPE,
      referenceId: key,
      payload: {
        scope: EXCEPTION_SCOPE,
        originalJobId: original.jobId,
        originalDeliveryStatus: original.deliveryStatus,
        reason: 'se a pessoa está no sistema é para enviar',
        consentStatusAtClaim: original.consent,
        phoneHash: createHash('sha256').update(normalizedPhone).digest('hex'),
      },
    }).catch(() => {})

    const [claimed] = await db.insert(messageJobs).values({
      leadId: original.leadId,
      messageId: null,
      upsellContent: null,
      scheduledFor: new Date(),
      status: 'pending',
      checkBeforeSend: false,
      jobType: ISABELLA_QUIZ_AUTHORIZED_EXCEPTION_JOB_TYPE,
      idempotencyKey: key,
      massDispatchBatchId: null,
      messageSnapshot: exceptionMessageSnapshot(batch),
      messageOrder: null,
    }).onConflictDoNothing({ target: messageJobs.idempotencyKey }).returning({
      id: messageJobs.id,
      leadId: messageJobs.leadId,
      status: messageJobs.status,
      externalWamid: messageJobs.externalWamid,
      idempotencyKey: messageJobs.idempotencyKey,
    })
    if (claimed) results.push(responseJob({ ...claimed, idempotencyKey: key }, original.phone))
    else {
      const [raced] = await db.select({
        id: messageJobs.id,
        leadId: messageJobs.leadId,
        status: messageJobs.status,
        externalWamid: messageJobs.externalWamid,
        idempotencyKey: messageJobs.idempotencyKey,
        phone: recoveryLeads.phone,
      }).from(messageJobs).innerJoin(recoveryLeads, eq(recoveryLeads.id, messageJobs.leadId)).where(eq(messageJobs.idempotencyKey, key)).limit(1)
      if (!raced) return NextResponse.json({ error: `Claim idempotente do job ${original.jobId} não pôde ser confirmado` }, { status: 503 })
      results.push(responseJob(raced, raced.phone))
    }
  }

  const cronSecret = process.env.CRON_SECRET
  let workerTriggered = false
  let workerStatus: number | null = null
  if (cronSecret && results.some(result => ['pending', 'queued'].includes(String(result.status)))) {
    try {
      const workerRequest = new NextRequest(new URL('/api/cron?authorized_quiz_exception=isabella_batch_35', req.url), {
        method: 'POST',
        headers: { Authorization: `Bearer ${cronSecret}` },
      })
      const workerResponse = await runDispatchCron(workerRequest)
      workerStatus = workerResponse.status
      workerTriggered = workerResponse.ok
      if (!workerResponse.ok) console.error('[quiz-isabella-exception] worker não concluiu', { status: workerResponse.status })
    } catch (error) {
      console.error('[quiz-isabella-exception] falha ao acionar worker', { error })
    }
  }

  return NextResponse.json({
    success: true,
    scope: EXCEPTION_SCOPE,
    batchId: QUIZ_BATCH_ID,
    queued: results.filter(result => ['pending', 'queued'].includes(String(result.status))).length,
    workerTriggered,
    workerStatus,
    jobs: results,
    skipped,
    rejectedLeaseJobs: 25,
    failedOriginalJobs: FAILED_JOB_IDS,
  })
}
