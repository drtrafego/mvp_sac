import { createHash, randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agentActivityLogs, sacAuditEvents, sacCodexJobs } from '@/lib/db/schema'
import { requireSacActor } from '@/lib/auth'
import { CODEX_ACTION_MAX_TEXT, normalizeActionText, parseCodexIntent, safeActionContext, stableCodexIdempotencyKey, validateAudioUpload, containsSecretLikeText } from '@/lib/codex-actions'
import { transcribeWithHermes } from '@/lib/hermes-transcriber'
import { submitToCodexGateway } from '@/lib/codex-gateway-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

async function audit(companyId: number, actorId: string, type: string, jobId: string, payload: Record<string, unknown>) {
  await db.insert(sacAuditEvents).values({ companyId, actorType: 'human', actorId, type, referenceType: 'codex_job', referenceId: jobId, payload })
}

export async function POST(req: NextRequest) {
  const actor = await requireSacActor()
  const form = await req.formData().catch(() => null)
  if (!form) return json({ error: 'Envie multipart/form-data.' }, 400)

  const rawText = form.get('text')
  const rawContext = form.get('context')
  const rawIdempotency = form.get('idempotencyKey')
  const text = normalizeActionText(typeof rawText === 'string' ? rawText : '')
  let context: Record<string, unknown> = {}
  if (typeof rawContext === 'string' && rawContext.trim()) {
    try { context = JSON.parse(rawContext) as Record<string, unknown> } catch { return json({ error: 'context deve ser JSON válido.' }, 400) }
  }

  const audio = form.get('audio')
  let transcript = text
  let inputKind: 'text' | 'audio' = 'text'
  let audioSha256: string | null = null
  let provider: string | null = null
  if (audio instanceof File) {
    const error = validateAudioUpload(audio.size, audio.type)
    if (error) return json({ error }, 400)
    inputKind = 'audio'
    const bytes = Buffer.from(await audio.arrayBuffer())
    audioSha256 = createHash('sha256').update(bytes).digest('hex')
    try {
      const result = await transcribeWithHermes(audio)
      transcript = result.transcript
      provider = result.provider ?? 'hermes-local'
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Falha na transcrição local.', code: 'TRANSCRIPTION_FAILED' }, 502)
    }
  }
  if (!transcript) return json({ error: 'Envie texto ou áudio.' }, 400)
  if (containsSecretLikeText(transcript)) return json({ error: 'O comando contém algo parecido com segredo; remova credenciais e tente novamente.' }, 400)
  if (transcript.length > CODEX_ACTION_MAX_TEXT) return json({ error: 'Texto excede o limite permitido.' }, 400)

  const safeContext = safeActionContext(context)
  const parsed = parseCodexIntent(transcript, context)
  const sessionId = normalizeActionText(typeof context.sessionId === 'string' ? context.sessionId : actor.actorId, 200)
  const idempotencyKey = normalizeActionText(typeof rawIdempotency === 'string' ? rawIdempotency : '', 200)
    || stableCodexIdempotencyKey(actor.company.id, sessionId, transcript, parsed.mediaId, parsed.targetText)

  const existing = await db.select().from(sacCodexJobs).where(and(eq(sacCodexJobs.companyId, actor.company.id), eq(sacCodexJobs.idempotencyKey, idempotencyKey))).limit(1)
  if (existing[0]) return json({ ok: true, job: existing[0], reused: true })

  const jobId = randomUUID()
  const now = new Date()
  await db.insert(sacCodexJobs).values({
    jobId,
    companyId: actor.company.id,
    idempotencyKey,
    sessionId,
    actorId: actor.actorId,
    inputKind,
    audioSha256,
    transcript,
    intent: parsed.intent,
    targetText: parsed.targetText,
    mediaId: parsed.mediaId,
    mediaUrl: parsed.mediaUrl,
    context: { ...safeContext, transcriptionProvider: provider },
    status: 'recebido',
    createdAt: now,
    updatedAt: now,
  })
  await audit(actor.company.id, actor.actorId, 'codex_job_received', jobId, { inputKind, intent: parsed.intent, audioSha256, transcriptLength: transcript.length })

  try {
    const gateway = await submitToCodexGateway({
      jobId,
      idempotencyKey,
      tenant: { id: actor.company.id, slug: actor.company.slug },
      sessionId,
      transcript,
      intent: parsed.intent,
      targetText: parsed.targetText,
      mediaId: parsed.mediaId,
      mediaUrl: parsed.mediaUrl,
      context: safeContext,
    })
    const status = typeof gateway.status === 'string' ? gateway.status : 'avaliando'
    const [updated] = await db.update(sacCodexJobs).set({ status, gatewayJobId: typeof gateway.jobId === 'string' ? gateway.jobId : jobId, result: gateway.result ?? null, updatedAt: new Date() }).where(and(eq(sacCodexJobs.companyId, actor.company.id), eq(sacCodexJobs.jobId, jobId))).returning()
    await audit(actor.company.id, actor.actorId, 'codex_job_gateway_submitted', jobId, { status, gatewayJobId: gateway.jobId ?? jobId, costUsd: gateway.costUsd ?? 0, tokens: gateway.tokens ?? null, calls: gateway.calls ?? null })
    return json({ ok: status !== 'erro', job: updated }, status === 'erro' ? 502 : 200)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao chamar o gateway Codex.'
    const [updated] = await db.update(sacCodexJobs).set({ status: 'erro', errorMessage: message.slice(0, 500), updatedAt: new Date() }).where(and(eq(sacCodexJobs.companyId, actor.company.id), eq(sacCodexJobs.jobId, jobId))).returning()
    await db.insert(agentActivityLogs).values({ companyId: actor.company.id, agentName: 'Codex', agentId: actor.actorId, action: 'codex.gateway.error', entityType: 'codex_job', entityId: jobId, details: { error: message.slice(0, 500) } })
    return json({ ok: false, error: message, job: updated }, 502)
  }
}
