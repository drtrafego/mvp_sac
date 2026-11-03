import { createHash } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'
import { requireSacActor } from '@/lib/auth'
import { db } from '@/lib/db'
import { companies, recoveryLeads, sacAudioAssets, sacAuditEvents, settings, whatsappMessages } from '@/lib/db/schema'
import { validateAudioUpload } from '@/lib/codex-actions'
import { transcribeWithHermes } from '@/lib/hermes-transcriber'
import { interpretConversation, type AiInsight } from '@/lib/ai/conversation-insight'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ leadId: string }> }

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Falha desconhecida.'
  return message.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redigido]').slice(0, 500)
}

type AudioAssetMetadata = Pick<typeof sacAudioAssets.$inferSelect, 'id' | 'filename' | 'mimeType' | 'sizeBytes' | 'sha256' | 'status' | 'transcript' | 'transcriptionProvider' | 'errorMessage' | 'aiInsight' | 'createdAt'>

function assetView(asset: AudioAssetMetadata, leadId: number) {
  return {
    id: asset.id,
    filename: asset.filename,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    sha256: asset.sha256,
    status: asset.status,
    transcript: asset.transcript,
    transcriptionProvider: asset.transcriptionProvider,
    errorMessage: asset.errorMessage,
    aiInsight: asset.aiInsight,
    createdAt: asset.createdAt?.toISOString() ?? null,
    mediaUrl: `/api/inbox/${leadId}/ai/audio/${asset.id}`,
  }
}

async function conversationContext(companyId: number, leadId: number) {
  return db.select({
    id: whatsappMessages.id,
    direction: whatsappMessages.direction,
    content: whatsappMessages.content,
    messageType: whatsappMessages.messageType,
    createdAt: whatsappMessages.createdAt,
    sendState: whatsappMessages.sendState,
    externalId: whatsappMessages.externalId,
  }).from(whatsappMessages)
    .where(and(eq(whatsappMessages.companyId, companyId), eq(whatsappMessages.leadId, leadId)))
    .orderBy(desc(whatsappMessages.createdAt), desc(whatsappMessages.id))
    .limit(20)
}

async function interpret(input: {
  company: typeof companies.$inferSelect
  lead: typeof recoveryLeads.$inferSelect
  config: typeof settings.$inferSelect | null
  transcript?: string | null
  source: 'conversation' | 'audio'
  assetId?: number
  actorId: string
}): Promise<AiInsight> {
  const messages = await conversationContext(input.company.id, input.lead.id)
  const insight = await interpretConversation({ ...input, messages })
  await db.insert(sacAuditEvents).values({
    companyId: input.company.id,
    leadId: input.lead.id,
    type: insight.state === 'interpreted' ? 'ai_conversation_interpreted' : 'ai_conversation_blocked',
    actorType: 'human',
    actorId: input.actorId,
    referenceType: input.source === 'audio' ? 'sac_audio_asset' : 'conversation',
    referenceId: input.assetId ? String(input.assetId) : String(messages.find(message => message.direction === 'inbound')?.id || input.lead.id),
    payload: {
      source: input.source,
      assetId: input.assetId ?? null,
      state: insight.state,
      intent: insight.intent,
      proposedAction: insight.proposedAction,
      consent: insight.consent,
      blockReason: insight.blockReason ?? null,
      evidenceCount: insight.evidence.length,
      transcriptLength: input.transcript?.length ?? 0,
    },
  })
  return insight
}

export async function GET(_req: NextRequest, { params }: Params) {
  const { leadId: rawLeadId } = await params
  const leadId = Number.parseInt(rawLeadId, 10)
  if (!Number.isSafeInteger(leadId) || leadId <= 0) return json({ error: 'Lead inválido.' }, 400)
  const actor = await requireSacActor()
  const [lead] = await db.select({ id: recoveryLeads.id }).from(recoveryLeads).where(and(eq(recoveryLeads.id, leadId), eq(recoveryLeads.companyId, actor.company.id))).limit(1)
  if (!lead) return json({ error: 'Atendimento não encontrado.' }, 404)
  const assets = await db.select({
    id: sacAudioAssets.id,
    filename: sacAudioAssets.filename,
    mimeType: sacAudioAssets.mimeType,
    sizeBytes: sacAudioAssets.sizeBytes,
    sha256: sacAudioAssets.sha256,
    status: sacAudioAssets.status,
    transcript: sacAudioAssets.transcript,
    transcriptionProvider: sacAudioAssets.transcriptionProvider,
    errorMessage: sacAudioAssets.errorMessage,
    aiInsight: sacAudioAssets.aiInsight,
    createdAt: sacAudioAssets.createdAt,
  }).from(sacAudioAssets).where(and(eq(sacAudioAssets.companyId, actor.company.id), eq(sacAudioAssets.leadId, leadId))).orderBy(desc(sacAudioAssets.createdAt)).limit(10)
  const events = await db.select({ id: sacAuditEvents.id, type: sacAuditEvents.type, payload: sacAuditEvents.payload, occurredAt: sacAuditEvents.occurredAt }).from(sacAuditEvents).where(and(eq(sacAuditEvents.companyId, actor.company.id), eq(sacAuditEvents.leadId, leadId))).orderBy(desc(sacAuditEvents.occurredAt)).limit(20)
  return json({ assets: assets.map(asset => assetView(asset, leadId)), events: events.map(event => ({ ...event, occurredAt: event.occurredAt?.toISOString() ?? null })) })
}

export async function POST(req: NextRequest, { params }: Params) {
  const { leadId: rawLeadId } = await params
  const leadId = Number.parseInt(rawLeadId, 10)
  if (!Number.isSafeInteger(leadId) || leadId <= 0) return json({ error: 'Lead inválido.' }, 400)
  const actor = await requireSacActor()
  const [lead] = await db.select().from(recoveryLeads).where(and(eq(recoveryLeads.id, leadId), eq(recoveryLeads.companyId, actor.company.id))).limit(1)
  if (!lead) return json({ error: 'Atendimento não encontrado.' }, 404)

  const form = await req.formData().catch(() => null)
  if (!form) return json({ error: 'Envie multipart/form-data.' }, 400)
  const audio = form.get('audio')
  const rawIdempotency = req.headers.get('x-ai-idempotency-key') || (typeof form.get('idempotencyKey') === 'string' ? form.get('idempotencyKey') as string : '')
  const idempotencyKey = rawIdempotency.trim().slice(0, 200)
  const [config] = await db.select().from(settings).where(eq(settings.companyId, actor.company.id)).limit(1)

  if (!(audio instanceof File)) {
    const insight = await interpret({ company: actor.company, lead, config: config ?? null, source: 'conversation', actorId: actor.actorId })
    return json({ ok: true, insight, asset: null })
  }

  const validationError = validateAudioUpload(audio.size, audio.type)
  if (validationError) return json({ error: validationError, code: 'AUDIO_INVALID' }, 400)
  if (!idempotencyKey) return json({ error: 'A chave de idempotência da análise está ausente.' }, 400)
  const bytes = Buffer.from(await audio.arrayBuffer())
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const existing = await db.select().from(sacAudioAssets).where(and(eq(sacAudioAssets.companyId, actor.company.id), eq(sacAudioAssets.idempotencyKey, idempotencyKey))).limit(1)
  if (existing[0]) {
    const asset = existing[0]
    const insight = asset.aiInsight as AiInsight | null
    return json({ ok: asset.status === 'interpreted', reused: true, asset: assetView(asset, leadId), insight })
  }

  const [asset] = await db.insert(sacAudioAssets).values({
    companyId: actor.company.id,
    leadId,
    idempotencyKey,
    filename: (audio.name || 'gravacao.webm').slice(0, 180),
    mimeType: audio.type.split(';', 1)[0].trim().toLowerCase(),
    sizeBytes: audio.size,
    sha256,
    audioData: bytes,
    status: 'recebido',
  }).returning()

  let transcript: string
  try {
    const result = await transcribeWithHermes(audio)
    transcript = result.transcript
    await db.update(sacAudioAssets).set({ status: 'transcrito', transcript, transcriptionProvider: result.provider ?? 'hermes-local', updatedAt: new Date() }).where(and(eq(sacAudioAssets.id, asset.id), eq(sacAudioAssets.companyId, actor.company.id)))
  } catch (error) {
    const message = safeError(error)
    const [failed] = await db.update(sacAudioAssets).set({ status: 'transcricao_bloqueada', errorMessage: message, updatedAt: new Date() }).where(and(eq(sacAudioAssets.id, asset.id), eq(sacAudioAssets.companyId, actor.company.id))).returning()
    await db.insert(sacAuditEvents).values({ companyId: actor.company.id, leadId, type: 'ai_audio_transcription_blocked', actorType: 'human', actorId: actor.actorId, referenceType: 'sac_audio_asset', referenceId: String(asset.id), payload: { assetId: asset.id, status: 'transcricao_bloqueada', reason: message, sha256 } })
    return json({ ok: false, code: 'TRANSCRIPTION_FAILED', error: message, asset: assetView(failed || { ...asset, status: 'transcricao_bloqueada', errorMessage: message }, leadId) }, 502)
  }

  try {
    const insight = await interpret({ company: actor.company, lead, config: config ?? null, transcript, source: 'audio', assetId: asset.id, actorId: actor.actorId })
    const [updated] = await db.update(sacAudioAssets).set({ status: insight.state === 'interpreted' ? 'interpreted' : 'ai_bloqueada', aiInsight: insight as unknown as Record<string, unknown>, updatedAt: new Date() }).where(and(eq(sacAudioAssets.id, asset.id), eq(sacAudioAssets.companyId, actor.company.id))).returning()
    return json({ ok: insight.state === 'interpreted', asset: assetView(updated || { ...asset, status: 'ai_bloqueada', transcript }, leadId), insight })
  } catch (error) {
    const message = safeError(error)
    const [failed] = await db.update(sacAudioAssets).set({ status: 'ai_bloqueada', errorMessage: message, transcript, updatedAt: new Date() }).where(and(eq(sacAudioAssets.id, asset.id), eq(sacAudioAssets.companyId, actor.company.id))).returning()
    await db.insert(sacAuditEvents).values({ companyId: actor.company.id, leadId, type: 'ai_conversation_blocked', actorType: 'human', actorId: actor.actorId, referenceType: 'sac_audio_asset', referenceId: String(asset.id), payload: { assetId: asset.id, reason: message, sha256 } })
    return json({ ok: false, code: 'AI_INTERPRETATION_FAILED', error: message, asset: assetView(failed || { ...asset, status: 'ai_bloqueada', transcript, errorMessage: message }, leadId) }, 502)
  }
}
