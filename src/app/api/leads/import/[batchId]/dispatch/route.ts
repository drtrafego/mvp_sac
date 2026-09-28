import { NextRequest, NextResponse } from 'next/server'
import { and, eq, sql } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import {
  massDispatchBatches,
  messageJobs,
  recoverySequences,
  sequenceMessages,
  settings,
} from '@/lib/db/schema'
import { buildMassDispatchPreview, isApprovedTemplateOnlySequence, queueMassDispatchBatch } from '@/lib/mass-dispatch'
import { listMetaTemplates } from '@/lib/whatsapp/meta'

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
  if (!Array.isArray(body.previewMessages)) {
    return NextResponse.json({ error: 'Preview aprovado é obrigatório; recarregue o preview antes de confirmar' }, { status: 400 })
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
  if (!isApprovedTemplateOnlySequence(preview.messages)) {
    return NextResponse.json({
      error: 'Esta sequência tem mensagem de texto livre; só é permitido disparo em massa com sequência 100% de template aprovado',
    }, { status: 409 })
  }

  const [config] = await db.select().from(settings).where(eq(settings.companyId, company.id)).limit(1)
  if (!config || (config.whatsappProvider ?? 'meta') !== 'meta' || !config.metaWabaId || !config.metaPhoneNumberId || !config.metaAccessToken) {
    return NextResponse.json({
      error: 'Disparo em massa exige Meta Cloud API configurada com WABA ID para validar templates aprovados',
    }, { status: 409 })
  }
  let approvedTemplateNames: Set<string>
  try {
    const approvedTemplates = await listMetaTemplates(config.metaWabaId, config.metaAccessToken)
    approvedTemplateNames = new Set(approvedTemplates.map(template => template.name))
  } catch (err) {
    console.error('[mass-dispatch] falha ao validar templates aprovados na Meta', err)
    return NextResponse.json({
      error: 'Não foi possível validar os templates aprovados na Meta; nenhum disparo foi enfileirado',
    }, { status: 503 })
  }
  if (!isApprovedTemplateOnlySequence(preview.messages, approvedTemplateNames)) {
    return NextResponse.json({
      error: 'A sequência contém template que não está aprovado na Meta; nenhum disparo foi enfileirado',
    }, { status: 409 })
  }

  const queued = await queueMassDispatchBatch(id, company.id, config.metaPhoneNumberId, body.previewMessages)
  if (queued.status === 'preview_changed') {
    return NextResponse.json({
      error: 'A sequência mudou depois do preview; revise o conteúdo atualizado antes de confirmar novamente',
    }, { status: 409 })
  }
  if (queued.status === 'non_template') {
    return NextResponse.json({
      error: 'Esta sequência tem mensagem de texto livre; só é permitido disparo em massa com sequência 100% de template aprovado',
    }, { status: 409 })
  }
  if (queued.status === 'daily_limit') {
    return NextResponse.json({
      error: 'Limite de mensagens em 24h atingido para este número',
      requested: queued.requested,
      available: queued.available,
    }, { status: 429 })
  }
  if (queued.status === 'no_eligible_messages') {
    return NextResponse.json({ error: 'Nenhum destinatário é elegível para o filtro de produto desta sequência' }, { status: 409 })
  }
  if (queued.status === 'not_found_or_claimed') {
    return NextResponse.json({ error: 'O lote foi confirmado por outra requisição ou não pôde ser enfileirado' }, { status: 409 })
  }
  return NextResponse.json({ success: true, batchId: id, status: 'queued', jobsCreated: queued.jobsCreated })
}
