import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'

export interface DispatchPreviewMessage {
  id: number
  order: number
  delayMinutes: number
  messageType: string
  content: string
  templateName: string | null
}

export interface MessageSnapshot {
  messageType: string
  content: string | null
  mediaUrl: string | null
  caption: string | null
  buttonsJson: unknown
  templateName: string | null
  templateLanguage: string | null
  templateVariablesMap: unknown
}

export function createMessageSnapshot(message: MessageSnapshot): MessageSnapshot {
  return structuredClone(message)
}

export function isApprovedTemplateOnlySequence(
  messages: Array<{ messageType?: string | null; templateName?: string | null }>,
  approvedTemplateNames?: ReadonlySet<string>,
): boolean {
  return messages.length > 0 && messages.every(message =>
    message.messageType === 'template'
      && Boolean(message.templateName?.trim())
      && (!approvedTemplateNames || approvedTemplateNames.has(message.templateName!.trim()))
  )
}

export function buildMassDispatchPreview(input: {
  batchId: number
  status: string
  recipientCount: number
  eventType: string
  messages: DispatchPreviewMessage[]
}) {
  const messages = [...input.messages].sort((a, b) => a.order - b.order)
  return {
    batchId: input.batchId,
    status: input.status,
    recipientCount: input.recipientCount,
    eventType: input.eventType,
    messageCount: messages.length,
    totalJobs: input.recipientCount * messages.length,
    messages,
  }
}

export type DispatchOutcome =
  | { status: 'sent'; externalWamid: string | null; sentAt: Date }
  | { status: 'sent_unconfirmed'; externalWamid: string | null; sentAt: Date; error: string }
  | { status: 'rate_limited'; retryAt: Date; error: string }
  | { status: 'failed'; error: string }

type RetryableError = Error & { status?: number; retryAfterMs?: number | null }

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function rateLimitOutcome(err: unknown, currentRetryCount: number, now: Date): DispatchOutcome | null {
  const retryable = err as RetryableError
  if (retryable?.status !== 429) return null
  const exponentialMs = Math.min(60 * 60_000, 30_000 * (2 ** Math.min(currentRetryCount, 7)))
  const retryAfterMs = Math.max(retryable.retryAfterMs ?? 0, exponentialMs)
  return { status: 'rate_limited', retryAt: new Date(now.getTime() + retryAfterMs), error: errorMessage(err) }
}

// Envio e persistência têm domínios de falha separados. Depois que o provedor
// aceitou uma mensagem, nenhuma falha de banco pode reclassificá-la como falha
// de envio (e, portanto, torná-la elegível a reenvio automático).
export async function executeAndRecordDispatch(
  send: () => Promise<string | null>,
  record: (outcome: DispatchOutcome) => Promise<void>,
  now: () => Date = () => new Date(),
  recordUnconfirmed?: (outcome: Extract<DispatchOutcome, { status: 'sent_unconfirmed' }>) => Promise<void>,
  currentRetryCount = 0,
): Promise<DispatchOutcome> {
  let externalWamid: string | null
  try {
    externalWamid = await send()
  } catch (err) {
    const outcome = rateLimitOutcome(err, currentRetryCount, now()) ?? {
      status: 'failed' as const,
      error: errorMessage(err),
    }
    await record(outcome)
    return outcome
  }

  const sentAt = now()
  const sent: DispatchOutcome = { status: 'sent', externalWamid, sentAt }
  try {
    await record(sent)
    return sent
  } catch (err) {
    const unconfirmed: Extract<DispatchOutcome, { status: 'sent_unconfirmed' }> = {
      status: 'sent_unconfirmed',
      externalWamid,
      sentAt,
      error: `Envio aceito pelo provedor, mas a confirmação não foi persistida: ${errorMessage(err)}`,
    }
    console.error('[mass-dispatch] ALERTA: envio aceito sem confirmação persistida', unconfirmed)
    if (recordUnconfirmed) {
      try {
        await recordUnconfirmed(unconfirmed)
      } catch (fallbackErr) {
        console.error('[mass-dispatch] ALERTA CRÍTICO: não foi possível persistir sent_unconfirmed', fallbackErr)
      }
    }
    return unconfirmed
  }
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows
  }
  return []
}

export const DEFAULT_META_DAILY_MESSAGE_LIMIT = 1000

export function metaDailyMessageLimit(): number {
  const configured = Number.parseInt(process.env.MASS_DISPATCH_META_DAILY_LIMIT ?? '', 10)
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_META_DAILY_MESSAGE_LIMIT
}

export type QueueMassDispatchResult =
  | { status: 'queued'; jobsCreated: number }
  | { status: 'not_found_or_claimed' }
  | { status: 'no_eligible_messages' }
  | { status: 'preview_changed' }
  | { status: 'non_template'; nonTemplateCount: number }
  | { status: 'daily_limit'; requested: number; available: number }

// A trava consultiva transacional serializa confirmações da mesma empresa.
// O segundo statement enxerga os jobs gravados por quem tinha a trava antes,
// impedindo dois lotes concorrentes de reservarem o mesmo orçamento de 24h.
export async function queueMassDispatchBatch(
  batchId: number,
  companyId: number,
  metaPhoneNumberId: string,
  approvedPreview: DispatchPreviewMessage[],
): Promise<QueueMassDispatchResult> {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(77421, hashtext(${metaPhoneNumberId}))`)
    const dailyLimit = metaDailyMessageLimit()
    const result = await tx.execute<{
      batch_count: number
      eligible_job_count: number
      non_template_count: number
      preview_matches: boolean
      reserved_count: number
      jobs_created: number
    }>(sql`
      WITH target_batch AS (
        SELECT b.*
        FROM mass_dispatch_batches b
        WHERE b.id = ${batchId}
          AND b.company_id = ${companyId}
          AND b.status = 'draft'
      ), eligible_pairs AS (
        SELECT r.lead_id, sm.id AS message_id, sm."order", sm.delay_minutes,
          jsonb_build_object(
            'messageType', coalesce(sm.message_type, 'text'),
            'content', sm.content,
            'mediaUrl', sm.media_url,
            'caption', sm.caption,
            'buttonsJson', sm.buttons_json,
            'templateName', sm.template_name,
            'templateLanguage', sm.template_language,
            'templateVariablesMap', sm.template_variables_map
          ) AS message_snapshot
        FROM target_batch b
        JOIN mass_dispatch_recipients r ON r.batch_id = b.id
        JOIN recovery_leads l ON l.id = r.lead_id AND l.company_id = b.company_id
        JOIN LATERAL (
          SELECT candidate.id
          FROM recovery_sequences candidate
          WHERE candidate.company_id = b.company_id
            AND candidate.event_type = b.event_type
            AND candidate.is_active = true
            AND (
              nullif(candidate.product_filter, '') IS NULL
              OR candidate.product_filter = l.product_id
              OR candidate.product_filter = l.product_name
            )
          ORDER BY CASE WHEN nullif(candidate.product_filter, '') IS NULL THEN 1 ELSE 0 END
          LIMIT 1
        ) rs ON true
        JOIN sequence_messages sm ON sm.sequence_id = rs.id AND sm.is_active = true
      ), current_preview AS (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', p.message_id,
          'order', p."order",
          'delayMinutes', coalesce(p.delay_minutes, 0),
          'messageType', p.message_snapshot->>'messageType',
          'content', coalesce(p.message_snapshot->>'content', ''),
          'templateName', p.message_snapshot->'templateName'
        ) ORDER BY p."order"), '[]'::jsonb) AS messages
        FROM (SELECT DISTINCT message_id, "order", delay_minutes, message_snapshot FROM eligible_pairs) p
      ), summary AS (
        SELECT
          (SELECT count(*)::int FROM target_batch) AS batch_count,
          count(*)::int AS eligible_job_count,
          count(*) FILTER (WHERE
            message_snapshot->>'messageType' <> 'template'
            OR nullif(message_snapshot->>'templateName', '') IS NULL
          )::int AS non_template_count,
          (SELECT messages FROM current_preview) = ${JSON.stringify(approvedPreview)}::jsonb AS preview_matches
        FROM eligible_pairs
      ), usage AS (
        SELECT count(*)::int AS reserved_count
        FROM message_jobs j
        JOIN recovery_leads l ON l.id = j.lead_id
        JOIN settings cfg ON cfg.company_id = l.company_id
        WHERE cfg.meta_phone_number_id = ${metaPhoneNumberId}
          AND j.mass_dispatch_batch_id IS NOT NULL
          AND (
            j.status IN ('pending', 'processing')
            OR (
              j.status IN ('sent', 'sent_unconfirmed')
              AND coalesce(j.sent_at, j.created_at) >= now() - interval '24 hours'
            )
          )
      ), claimed AS (
        UPDATE mass_dispatch_batches b
        SET status = 'queued', confirmed_at = now()
        FROM summary s, usage u
        WHERE b.id = ${batchId}
          AND b.company_id = ${companyId}
          AND b.status = 'draft'
          AND s.eligible_job_count > 0
          AND s.preview_matches
          AND s.non_template_count = 0
          AND u.reserved_count + s.eligible_job_count <= ${dailyLimit}
        RETURNING b.id
      ), inserted AS (
        INSERT INTO message_jobs (
          lead_id, message_id, message_order, scheduled_for, status,
          check_before_send, mass_dispatch_batch_id, message_snapshot
        )
        SELECT p.lead_id, p.message_id, p."order",
               now() + (coalesce(p.delay_minutes, 0) * interval '1 minute'),
               'pending', true, c.id, p.message_snapshot
        FROM claimed c
        JOIN eligible_pairs p ON true
        ON CONFLICT (mass_dispatch_batch_id, lead_id, message_id) DO NOTHING
        RETURNING id
      )
      SELECT s.batch_count, s.eligible_job_count, s.non_template_count, s.preview_matches,
             u.reserved_count, (SELECT count(*)::int FROM inserted) AS jobs_created
      FROM summary s CROSS JOIN usage u
    `)
    const [row] = rowsOf<{
      batch_count: number
      eligible_job_count: number
      non_template_count: number
      preview_matches: boolean
      reserved_count: number
      jobs_created: number
    }>(result)
    if (!row || Number(row.batch_count) === 0) return { status: 'not_found_or_claimed' }
    if (Number(row.eligible_job_count) === 0) return { status: 'no_eligible_messages' }
    if (!row.preview_matches) return { status: 'preview_changed' }
    if (Number(row.non_template_count) > 0) {
      return { status: 'non_template', nonTemplateCount: Number(row.non_template_count) }
    }
    const jobsCreated = Number(row.jobs_created)
    if (jobsCreated === 0) {
      return {
        status: 'daily_limit',
        requested: Number(row.eligible_job_count),
        available: Math.max(0, dailyLimit - Number(row.reserved_count)),
      }
    }
    return { status: 'queued', jobsCreated }
  })
}
