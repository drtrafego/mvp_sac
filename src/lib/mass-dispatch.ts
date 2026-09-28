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
  | { status: 'failed'; error: string }

// Pequeno núcleo testável do executor real: toda tentativa de rede termina
// com um registro individual, inclusive quando o provedor lança exceção.
export async function executeAndRecordDispatch(
  send: () => Promise<string | null>,
  record: (outcome: DispatchOutcome) => Promise<void>,
  now: () => Date = () => new Date(),
): Promise<DispatchOutcome> {
  try {
    const externalWamid = await send()
    const outcome: DispatchOutcome = { status: 'sent', externalWamid, sentAt: now() }
    await record(outcome)
    return outcome
  } catch (err) {
    const outcome: DispatchOutcome = {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    }
    await record(outcome)
    return outcome
  }
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows
  }
  return []
}

// Claim + criação dos jobs acontecem na mesma instrução SQL. Assim dois
// cliques/retries concorrentes não duplicam a campanha e um lote sem mensagens
// ativas permanece draft.
export async function queueMassDispatchBatch(batchId: number, companyId: number): Promise<number | null> {
  const result = await db.execute<{ jobs_created: number }>(sql`
    WITH eligible_messages AS (
      SELECT sm.id, sm."order", sm.delay_minutes
      FROM mass_dispatch_batches b
      JOIN recovery_sequences rs
        ON rs.company_id = b.company_id
       AND rs.event_type = b.event_type
       AND rs.is_active = true
      JOIN sequence_messages sm
        ON sm.sequence_id = rs.id
       AND sm.is_active = true
      WHERE b.id = ${batchId}
        AND b.company_id = ${companyId}
        AND b.status = 'draft'
    ), claimed AS (
      UPDATE mass_dispatch_batches b
      SET status = 'queued', confirmed_at = now()
      WHERE b.id = ${batchId}
        AND b.company_id = ${companyId}
        AND b.status = 'draft'
        AND EXISTS (SELECT 1 FROM eligible_messages)
        AND EXISTS (SELECT 1 FROM mass_dispatch_recipients r WHERE r.batch_id = b.id)
      RETURNING b.id
    ), inserted AS (
      INSERT INTO message_jobs (
        lead_id, message_id, message_order, scheduled_for, status,
        check_before_send, mass_dispatch_batch_id
      )
      SELECT r.lead_id, m.id, m."order",
             now() + (coalesce(m.delay_minutes, 0) * interval '1 minute'),
             'pending', true, c.id
      FROM claimed c
      JOIN mass_dispatch_recipients r ON r.batch_id = c.id
      CROSS JOIN eligible_messages m
      ON CONFLICT (mass_dispatch_batch_id, lead_id, message_id) DO NOTHING
      RETURNING id
    )
    SELECT count(*)::int AS jobs_created FROM inserted
  `)
  const [row] = rowsOf<{ jobs_created: number }>(result)
  return row ? Number(row.jobs_created) : null
}
