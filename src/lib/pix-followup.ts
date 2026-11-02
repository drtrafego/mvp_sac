import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  metaMessageTemplates,
  messageJobs,
  recoveryLeads,
  recoverySequences,
  sacAuditEvents,
  sequenceMessages,
  settings,
} from '@/lib/db/schema'
import {
  buildPixFollowupIdempotencyKey,
  isApprovedUtilityPixTemplate,
  isRealPendingPix,
  PIX_FOLLOWUP_DELAY_MINUTES,
  PIX_FOLLOWUP_JOB_TYPE,
  PIX_FOLLOWUP_TEMPLATE_LANGUAGE,
  PIX_FOLLOWUP_TEMPLATE_NAME,
  validatePixFollowupMessage,
} from '@/lib/pix-followup-policy'
import { selectRecoverySequence } from '@/lib/recovery-sequence'

type DatabaseLead = typeof recoveryLeads.$inferSelect

type PixScheduleResult =
  | { scheduled: true; jobId: number; duplicate: false }
  | { scheduled: true; jobId: number; duplicate: true }
  | { scheduled: false; reason: string }

async function auditPixEvent(args: {
  companyId: number
  leadId?: number | null
  type: string
  referenceId?: string | null
  payload: Record<string, unknown>
}): Promise<boolean> {
  try {
    await db.insert(sacAuditEvents).values({
      companyId: args.companyId,
      leadId: args.leadId ?? null,
      type: args.type,
      actorType: 'system',
      actorId: 'pix_followup_60m',
      actorName: 'SAC Pix follow-up',
      referenceType: 'message_job',
      referenceId: args.referenceId ?? null,
      payload: args.payload,
    })
    return true
  } catch (error) {
    console.error('[pix-followup] falha ao gravar auditoria', {
      companyId: args.companyId,
      leadId: args.leadId ?? null,
      type: args.type,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

export async function schedulePixFollowup(lead: DatabaseLead, now = new Date()): Promise<PixScheduleResult> {
  const eligibility = isRealPendingPix(lead)
  if (!eligibility.eligible) {
    await auditPixEvent({
      companyId: lead.companyId,
      leadId: lead.id,
      type: 'pix_followup_not_scheduled',
      payload: { reason: eligibility.reason },
    })
    return { scheduled: false, reason: eligibility.reason }
  }

  const [config] = await db
    .select({ whatsappProvider: settings.whatsappProvider, metaPhoneNumberId: settings.metaPhoneNumberId })
    .from(settings)
    .where(eq(settings.companyId, lead.companyId))
    .limit(1)
  if ((config?.whatsappProvider ?? 'meta') !== 'meta' || !config?.metaPhoneNumberId) {
    return await blockPixSchedule(lead, 'WhatsApp Meta não está configurado para o follow-up Pix')
  }

  const sequences = await db
    .select()
    .from(recoverySequences)
    .where(and(
      eq(recoverySequences.companyId, lead.companyId),
      eq(recoverySequences.eventType, 'pix'),
      eq(recoverySequences.isActive, true),
    ))
  const sequence = selectRecoverySequence(sequences, lead.productId, lead.productName)
  if (!sequence) return await blockPixSchedule(lead, 'sequência Pix ativa não configurada')

  const messages = await db
    .select()
    .from(sequenceMessages)
    .where(and(eq(sequenceMessages.sequenceId, sequence.id), eq(sequenceMessages.isActive, true)))
    .orderBy(asc(sequenceMessages.order))
  if (messages.length !== 1) {
    return await blockPixSchedule(lead, 'sequência Pix precisa ter exatamente uma mensagem ativa')
  }

  const message = messages[0]
  const messageGate = validatePixFollowupMessage(message)
  if (!messageGate.eligible) return await blockPixSchedule(lead, messageGate.reason)

  const [template] = await db
    .select({ name: metaMessageTemplates.name, language: metaMessageTemplates.language, status: metaMessageTemplates.status, category: metaMessageTemplates.category })
    .from(metaMessageTemplates)
    .where(and(
      eq(metaMessageTemplates.companyId, lead.companyId),
      eq(metaMessageTemplates.name, PIX_FOLLOWUP_TEMPLATE_NAME),
      eq(metaMessageTemplates.language, PIX_FOLLOWUP_TEMPLATE_LANGUAGE),
    ))
    .limit(1)
  if (!isApprovedUtilityPixTemplate(template)) {
    return await blockPixSchedule(lead, 'template Pix não está APPROVED na categoria UTILITY')
  }

  const idempotencyKey = buildPixFollowupIdempotencyKey(lead.companyId, lead.transactionId!)
  const [job] = await db
    .insert(messageJobs)
    .values({
      leadId: lead.id,
      messageId: message.id,
      scheduledFor: new Date(now.getTime() + PIX_FOLLOWUP_DELAY_MINUTES * 60_000),
      status: 'pending',
      checkBeforeSend: true,
      messageOrder: message.order,
      jobType: PIX_FOLLOWUP_JOB_TYPE,
      idempotencyKey,
    })
    .onConflictDoNothing({ target: messageJobs.idempotencyKey })
    .returning({ id: messageJobs.id })

  if (!job) {
    const [existing] = await db
      .select({ id: messageJobs.id })
      .from(messageJobs)
      .where(eq(messageJobs.idempotencyKey, idempotencyKey))
      .limit(1)
    return { scheduled: true, jobId: existing?.id ?? 0, duplicate: true }
  }

  const audited = await auditPixEvent({
    companyId: lead.companyId,
    leadId: lead.id,
    type: 'pix_followup_scheduled',
    referenceId: String(job.id),
    payload: {
      jobType: PIX_FOLLOWUP_JOB_TYPE,
      delayMinutes: PIX_FOLLOWUP_DELAY_MINUTES,
      templateName: PIX_FOLLOWUP_TEMPLATE_NAME,
      templateLanguage: PIX_FOLLOWUP_TEMPLATE_LANGUAGE,
    },
  })
  if (!audited) {
    await db.update(messageJobs).set({
      status: 'cancelled',
      error: 'Auditoria do follow-up Pix não foi registrada',
    }).where(eq(messageJobs.id, job.id))
    return { scheduled: false, reason: 'auditoria do follow-up Pix indisponível' }
  }

  return { scheduled: true, jobId: job.id, duplicate: false }
}

async function blockPixSchedule(lead: DatabaseLead, reason: string): Promise<{ scheduled: false; reason: string }> {
  await auditPixEvent({
    companyId: lead.companyId,
    leadId: lead.id,
    type: 'pix_followup_not_scheduled',
    payload: { reason },
  })
  return { scheduled: false, reason }
}

export async function cancelPixFollowupsForPayment(args: {
  companyId: number
  phone: string
  transactionId?: string | null
}): Promise<number> {
  const result = await db.execute<{ id: number; lead_id: number }>(sql`
    UPDATE message_jobs AS job
    SET status = 'cancelled',
        error = 'Pagamento confirmado antes do follow-up Pix',
        processing_started_at = NULL
    WHERE job.job_type = ${PIX_FOLLOWUP_JOB_TYPE}
      AND job.status IN ('pending', 'processing')
      AND job.lead_id IN (
        SELECT lead.id
        FROM recovery_leads AS lead
        WHERE lead.company_id = ${args.companyId}
          AND lead.event_type = 'pix'
          AND lead.phone = ${args.phone}
          AND (${args.transactionId ?? null} IS NULL OR lead.transaction_id = ${args.transactionId ?? null})
      )
    RETURNING job.id, job.lead_id
  `)

  const rows = Array.isArray(result) ? result : result.rows
  for (const row of rows) {
    await auditPixEvent({
      companyId: args.companyId,
      leadId: row.lead_id,
      type: 'pix_followup_cancelled_paid',
      referenceId: String(row.id),
      payload: { reason: 'pagamento confirmado antes do envio' },
    })
  }
  return rows.length
}

export async function recordPixFollowupSent(args: {
  companyId: number
  leadId: number
  jobId: number
  externalWamid?: string | null
}): Promise<void> {
  await auditPixEvent({
    companyId: args.companyId,
    leadId: args.leadId,
    type: 'pix_followup_sent',
    referenceId: String(args.jobId),
    payload: {
      jobType: PIX_FOLLOWUP_JOB_TYPE,
      externalWamid: args.externalWamid ?? null,
    },
  })
}
