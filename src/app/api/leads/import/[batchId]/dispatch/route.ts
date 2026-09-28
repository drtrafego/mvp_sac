import { NextRequest, NextResponse } from 'next/server'
import { and, eq, sql } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import {
  massDispatchBatches,
  messageJobs,
  recoverySequences,
  sequenceMessages,
} from '@/lib/db/schema'
import { buildMassDispatchPreview, queueMassDispatchBatch } from '@/lib/mass-dispatch'

type Params = { params: Promise<{ batchId: string }> }

async function loadPreview(batchId: number, companyId: number) {
  const [batch] = await db.select().from(massDispatchBatches).where(and(
    eq(massDispatchBatches.id, batchId),
    eq(massDispatchBatches.companyId, companyId),
  )).limit(1)
  if (!batch) return null

  const messages = await db.select({
    id: sequenceMessages.id,
    order: sequenceMessages.order,
    delayMinutes: sequenceMessages.delayMinutes,
    messageType: sequenceMessages.messageType,
    content: sequenceMessages.content,
    templateName: sequenceMessages.templateName,
  }).from(sequenceMessages).innerJoin(
    recoverySequences,
    eq(sequenceMessages.sequenceId, recoverySequences.id),
  ).where(and(
    eq(recoverySequences.companyId, companyId),
    eq(recoverySequences.eventType, batch.eventType),
    eq(recoverySequences.isActive, true),
    eq(sequenceMessages.isActive, true),
  )).orderBy(sequenceMessages.order)

  const statsRows = await db.select({
    status: messageJobs.status,
    count: sql<number>`cast(count(*) as int)`,
  }).from(messageJobs).where(eq(messageJobs.massDispatchBatchId, batchId)).groupBy(messageJobs.status)

  const stats = Object.fromEntries(statsRows.map(row => [row.status ?? 'unknown', row.count]))
  return {
    ...buildMassDispatchPreview({
      batchId,
      status: batch.status,
      recipientCount: batch.recipientCount,
      eventType: batch.eventType,
      messages: messages.map(message => ({
        ...message,
        delayMinutes: message.delayMinutes ?? 0,
        messageType: message.messageType ?? 'text',
        content: message.content ?? '',
      })),
    }),
    stats,
  }
}

export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const company = await requireCompany()
  const id = Number.parseInt((await params).batchId, 10)
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'Lote inválido' }, { status: 400 })
  const preview = await loadPreview(id, company.id)
  if (!preview) return NextResponse.json({ error: 'Lote não encontrado' }, { status: 404 })
  return NextResponse.json(preview)
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const company = await requireCompany()
  const id = Number.parseInt((await params).batchId, 10)
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'Lote inválido' }, { status: 400 })
  const body = await req.json().catch(() => ({}))
  if (body.confirm !== true) {
    return NextResponse.json({ error: 'Confirmação explícita obrigatória' }, { status: 400 })
  }

  const preview = await loadPreview(id, company.id)
  if (!preview) return NextResponse.json({ error: 'Lote não encontrado' }, { status: 404 })
  if (preview.status !== 'draft') {
    return NextResponse.json({ error: 'Este lote já foi confirmado', preview }, { status: 409 })
  }
  if (preview.recipientCount === 0) {
    return NextResponse.json({ error: 'O lote não tem destinatários válidos' }, { status: 409 })
  }
  if (preview.messageCount === 0) {
    return NextResponse.json({ error: 'Nenhuma mensagem ativa configurada para este tipo de evento' }, { status: 409 })
  }

  const jobsCreated = await queueMassDispatchBatch(id, company.id)
  if (jobsCreated === null || jobsCreated === 0) {
    return NextResponse.json({ error: 'O lote foi confirmado por outra requisição ou não pôde ser enfileirado' }, { status: 409 })
  }
  return NextResponse.json({ success: true, batchId: id, status: 'queued', jobsCreated })
}
