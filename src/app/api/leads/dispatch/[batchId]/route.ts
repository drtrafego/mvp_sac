import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import { massDispatchBatches, messageJobs } from '@/lib/db/schema'

function numericBatchId(value: string): number | null {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

export async function GET(_request: NextRequest, context: { params: Promise<{ batchId: string }> }): Promise<NextResponse> {
  const company = await requireCompany()
  const { batchId: rawBatchId } = await context.params
  const batchId = numericBatchId(rawBatchId)
  if (!batchId) return NextResponse.json({ error: 'Lote inválido' }, { status: 400 })

  const [batch] = await db.select({
    id: massDispatchBatches.id,
    status: massDispatchBatches.status,
    recipientCount: massDispatchBatches.recipientCount,
    requestedCount: massDispatchBatches.requestedCount,
    skippedCount: massDispatchBatches.skippedCount,
    templateName: massDispatchBatches.templateName,
    templateLanguage: massDispatchBatches.templateLanguage,
    createdAt: massDispatchBatches.createdAt,
    confirmedAt: massDispatchBatches.confirmedAt,
  }).from(massDispatchBatches).where(and(eq(massDispatchBatches.id, batchId), eq(massDispatchBatches.companyId, company.id))).limit(1)
  if (!batch) return NextResponse.json({ error: 'Lote não encontrado' }, { status: 404 })

  const jobs = await db.select({
    id: messageJobs.id,
    status: messageJobs.status,
    error: messageJobs.error,
    externalWamid: messageJobs.externalWamid,
    deliveryStatus: messageJobs.deliveryStatus,
    sentAt: messageJobs.sentAt,
    processingStartedAt: messageJobs.processingStartedAt,
    createdAt: messageJobs.createdAt,
  }).from(messageJobs).where(eq(messageJobs.massDispatchBatchId, batchId))

  const pending = jobs.filter(job => ['pending', 'processing', 'queued'].includes(job.status ?? ''))
  const failed = jobs.filter(job => job.status === 'failed')
  const accepted = jobs.filter(job => ['sent', 'sent_unconfirmed'].includes(job.status ?? '') || ['sent', 'delivered', 'read'].includes(job.deliveryStatus ?? ''))
  const status = pending.length > 0 || jobs.length === 0
    ? 'queued'
    : failed.length === jobs.length
      ? 'failed'
      : accepted.length === jobs.length
        ? 'accepted'
        : failed.length > 0
          ? 'partial_failure'
          : 'processing'

  return NextResponse.json({
    batch: { ...batch, status },
    counts: {
      total: jobs.length,
      active: pending.length,
      pending: jobs.filter(job => job.status === 'pending').length,
      processing: jobs.filter(job => job.status === 'processing').length,
      queued: jobs.filter(job => job.status === 'queued').length,
      sent: jobs.filter(job => ['sent', 'sent_unconfirmed'].includes(job.status ?? '')).length,
      failed: failed.length,
      cancelled: jobs.filter(job => job.status === 'cancelled').length,
      accepted: accepted.length,
    },
    jobs,
  })
}
