// generateAndSendAiReply roda via after() e chama a ponte de IA, que tem
// timeout de 150s (TIMEOUT_MS em src/lib/ai/ai-bridge.ts). Sem maxDuration
// explícito, o default da Vercel pode matar a function antes disso e o
// finally que libera o lock de concorrência nunca roda.
export const maxDuration = 180

import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { db } from '@/lib/db'
import { whatsappMessages, recoveryLeads, settings, messageJobs } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'
import { checkWebhookToken } from '@/lib/webhook-auth'
import { markLeadContacted } from '@/lib/leads'
import { verifyMetaSignature } from '@/lib/meta-signature'
import { generateAndSendAiReply } from '@/lib/ai-reply'
import { isInboundMessageAlreadyProcessed, isUniqueViolation } from '@/lib/webhook-dedup'

function normalizePhone(raw: string): string {
  return raw.replace(/[@+\s\-().]/g, '').replace(/@.*$/, '').replace(/^0+/, '')
}

// Extrai o phone_number_id cedo, só pra resolver qual empresa validar o
// segredo, ANTES de qualquer outro processamento do payload.
function extractPhoneNumberIdForSecret(body: Record<string, unknown>): string | null {
  if (body.object !== 'whatsapp_business_account') return null
  const entries = (body.entry as Record<string, unknown>[]) ?? []
  for (const entry of entries) {
    const changes = (entry.changes as Record<string, unknown>[]) ?? []
    for (const change of changes) {
      const value = change.value as Record<string, unknown> | undefined
      const phoneNumberId = value?.metadata ? (value.metadata as Record<string, string>).phone_number_id : null
      if (phoneNumberId) return phoneNumberId
    }
  }
  return null
}

// ─── Meta Cloud API ───────────────────────────────────────────────────────────

interface MetaStatus {
  id: string
  status: string // sent | delivered | read | failed
  phoneNumberId: string
}

function extractMetaStatuses(body: Record<string, unknown>): MetaStatus[] {
  if (body.object !== 'whatsapp_business_account') return []
  const result: MetaStatus[] = []
  const entries = (body.entry as Record<string, unknown>[]) ?? []
  for (const entry of entries) {
    const changes = (entry.changes as Record<string, unknown>[]) ?? []
    for (const change of changes) {
      const value = change.value as Record<string, unknown> | undefined
      if (!value) continue
      const phoneNumberId = value.metadata ? (value.metadata as Record<string, string>).phone_number_id : ''
      const statuses = (value.statuses as Record<string, unknown>[]) ?? []
      for (const s of statuses) {
        const wamid = s.id as string | undefined
        const status = s.status as string | undefined
        if (wamid && status) result.push({ id: wamid, status, phoneNumberId })
      }
    }
  }
  return result
}

function extractMeta(body: Record<string, unknown>) {
  if (body.object !== 'whatsapp_business_account') return null
  const entries = (body.entry as Record<string, unknown>[]) ?? []
  for (const entry of entries) {
    const changes = (entry.changes as Record<string, unknown>[]) ?? []
    for (const change of changes) {
      const value = change.value as Record<string, unknown> | undefined
      if (!value) continue
      const phoneNumberId = value.metadata ? (value.metadata as Record<string, string>).phone_number_id : null
      const messages = (value.messages as Record<string, unknown>[]) ?? []
      for (const msg of messages) {
        const from = msg.from as string | undefined
        if (!from) continue
        const type = (msg.type as string) ?? 'text'
        let content: string | null = null
        let mediaUrl: string | null = null
        let messageType = 'text'
        if (type === 'text') {
          content = (msg.text as Record<string, string>)?.body ?? null
        } else if (type === 'image') {
          messageType = 'image'
        } else if (type === 'audio') {
          messageType = 'audio'
        } else if (type === 'video') {
          messageType = 'video'
        } else if (type === 'document') {
          messageType = 'document'
        }
        const contacts = (value.contacts as Record<string, unknown>[]) ?? []
        const name = contacts[0] ? (contacts[0].profile as Record<string, string>)?.name ?? null : null
        return { phone: normalizePhone(from), name, content, mediaUrl, messageType, externalId: msg.id as string | null, phoneNumberId, provider: 'meta' as const }
      }
    }
  }
  return null
}

// ─── UazAPI ───────────────────────────────────────────────────────────────────
function extractUazapi(body: Record<string, unknown>) {
  const data = body.data as Record<string, unknown> | undefined
  if (!data) return null
  const key = data.key as Record<string, unknown> | undefined
  if (!key || key.fromMe === true) return null
  const remoteJid = key.remoteJid as string | undefined
  if (!remoteJid) return null

  const phone = normalizePhone(remoteJid)
  const name = (data.pushName as string) || null
  const msgObj = data.message as Record<string, unknown> | undefined
  const msgType = (data.messageType as string) || 'conversation'
  const instanceToken = (body.instanceToken as string) || null

  let content: string | null = null
  let messageType = 'text'

  if (msgType === 'conversation' || msgType === 'extendedTextMessage') {
    content = (msgObj?.conversation as string) || (msgObj?.extendedTextMessage as Record<string, string>)?.text || null
  } else if (msgType === 'imageMessage') {
    messageType = 'image'
  } else if (msgType === 'audioMessage') {
    messageType = 'audio'
  } else if (msgType === 'videoMessage') {
    messageType = 'video'
  }

  return { phone, name, content, mediaUrl: null, messageType, externalId: key.id as string | null, instanceToken, provider: 'uazapi' as const }
}

// ─── GET: verificação de webhook Meta ─────────────────────────────────────────
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url)
  const mode = searchParams.get('hub.mode')
  const token = searchParams.get('hub.verify_token')
  const challenge = searchParams.get('hub.challenge')

  if (mode === 'subscribe' && token && challenge) {
    const [config] = await db.select().from(settings).where(eq(settings.metaVerifyToken, token))
    if (config) return new NextResponse(challenge, { status: 200 })
    return NextResponse.json({ error: 'Token inválido' }, { status: 403 })
  }

  return NextResponse.json({ ok: true })
}

// ─── POST: recebe mensagens e status de entrega ───────────────────────────────
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const rawBody = await req.text()
    let body: Record<string, unknown>
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Payload inválido' }, { status: 400 })
    }

    const isMeta = body.object === 'whatsapp_business_account'

    if (isMeta) {
      // Validação da assinatura x-hub-signature-256 da Meta: falha fechada, nunca aceita sem checagem.
      // Se a empresa (achada pelo phone_number_id do payload) tiver App Secret próprio, usa o dela;
      // senão cai no META_APP_SECRET compartilhado de hoje.
      let companySecret: string | null = null
      let companyId: number | null = null
      const phoneNumberIdForSecret = extractPhoneNumberIdForSecret(body)
      if (phoneNumberIdForSecret) {
        const [cfgForSecret] = await db
          .select({ companyId: settings.companyId, metaAppSecret: settings.metaAppSecret })
          .from(settings)
          .where(eq(settings.metaPhoneNumberId, phoneNumberIdForSecret))
        companySecret = cfgForSecret?.metaAppSecret ?? null
        companyId = cfgForSecret?.companyId ?? null
      }
      const secret = companySecret || process.env.META_APP_SECRET || process.env.WHATSAPP_APP_SECRET
      if (!secret) {
        console.error('[WhatsApp Webhook] Nenhum App Secret configurado (nem da empresa, nem o compartilhado), recusando requisição', { phoneNumberId: phoneNumberIdForSecret, companyId })
        return NextResponse.json({ error: 'meta_app_secret_not_configured' }, { status: 503 })
      }
      const sigHeader = req.headers.get('x-hub-signature-256')
      if (!sigHeader || !verifyMetaSignature(rawBody, sigHeader, secret)) {
        console.error('[WhatsApp Webhook] Assinatura invalida, recusando requisicao', { phoneNumberId: phoneNumberIdForSecret, companyId, temSigHeader: Boolean(sigHeader) })
        return NextResponse.json({ error: 'Assinatura inválida ou ausente' }, { status: 401 })
      }
    } else {
      // UazAPI ou Webhook genérico
      const instanceToken = (body.instanceToken as string) || (body.instance as string) || null
      if (instanceToken) {
        const [cfg] = await db.select().from(settings).where(eq(settings.uazapiInstanceToken, instanceToken))
        if (!cfg) {
          return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
        }
      } else {
        const auth = checkWebhookToken(req)
        if (!auth.ok) {
          return NextResponse.json({ error: auth.reason }, { status: auth.status })
        }
      }
    }

    // Processar atualizações de status (sent/delivered/read) da Meta
    const metaStatuses = extractMetaStatuses(body)
    if (metaStatuses.length > 0) {
      for (const s of metaStatuses) {
        await db
          .update(messageJobs)
          .set({ deliveryStatus: s.status })
          .where(eq(messageJobs.externalWamid, s.id))
      }
    }

    const parsed = extractMeta(body) ?? extractUazapi(body)
    if (!parsed || !parsed.phone) return NextResponse.json({ ok: true, skipped: true })

    const { phone, name, content, mediaUrl, messageType, externalId } = parsed

    let companyId: number | null = null

    if (parsed.provider === 'meta' && 'phoneNumberId' in parsed && parsed.phoneNumberId) {
      const [cfg] = await db.select().from(settings).where(eq(settings.metaPhoneNumberId, parsed.phoneNumberId))
      companyId = cfg?.companyId ?? null
    } else if (parsed.provider === 'uazapi' && 'instanceToken' in parsed && parsed.instanceToken) {
      const [cfg] = await db.select().from(settings).where(eq(settings.uazapiInstanceToken, parsed.instanceToken))
      companyId = cfg?.companyId ?? null
    }

    if (!companyId) return NextResponse.json({ ok: true, skipped: true })

    // Idempotência contra reentrega de webhook da Meta: reentrega é
    // comportamento real dela, não hipotético. Checa ANTES de tocar no lead:
    // senão a reentrega "ressuscita" um lead que já tinha sido resolvido
    // (bump de status/updatedAt/lastActionAt pelo upsert) mesmo sem nenhuma
    // mensagem nova de verdade ser gravada. Mesmo padrão de ordem das rotas
    // de Instagram (dedup antes do upsert do lead).
    if (await isInboundMessageAlreadyProcessed(companyId, externalId)) {
      console.log(`[WhatsApp Webhook] mensagem já processada (reentrega da Meta), externalId=${externalId}, pulando`)
      return NextResponse.json({ ok: true, duplicate: true })
    }

    // Upsert atômico: SELECT-então-INSERT deixava uma janela de corrida entre
    // duas requisições concorrentes com o mesmo telefone novo, e cada uma
    // criava um lead próprio (provado pelo QA ao vivo: 10 requisições
    // concorrentes → 6 leads distintos pro mesmo telefone). O índice único
    // parcial recovery_leads_chat_company_phone_unique (ver schema.ts) fecha
    // essa corrida no banco. Nome só é sobrescrito se o lead ainda não tinha
    // um (mesma regra de antes: NULLIF trata string vazia como "sem nome").
    const [lead] = await db
      .insert(recoveryLeads)
      .values({
        companyId,
        phone,
        name: name || `WhatsApp ${phone.slice(-4)}`,
        platform: 'sac',
        channel: 'whatsapp',
        eventType: 'atendimento',
        status: 'in_conversation',
        trackingSource: 'whatsapp_direto',
      })
      .onConflictDoUpdate({
        target: [recoveryLeads.companyId, recoveryLeads.phone],
        // Precisa bater EXATAMENTE com o WHERE do índice
        // recovery_leads_chat_company_phone_unique (schema.ts) pro Postgres
        // inferir o arbiter do ON CONFLICT. Ampliado pra incluir 'hermes' em
        // 22/09/2026 junto com a migration 0010 (fix de concorrência no
        // webhook de conversão do Hermes) — mudou lá, muda aqui também.
        targetWhere: sql`${recoveryLeads.platform} in ('instagram', 'sac', 'hermes')`,
        set: {
          updatedAt: new Date(),
          lastActionAt: new Date(),
          status: 'in_conversation',
          ...(name ? { name: sql`COALESCE(NULLIF(${recoveryLeads.name}, ''), ${name})` } : {}),
        },
      })
      .returning()

    const leadId = lead.id

    try {
      await db.insert(whatsappMessages).values({
        companyId,
        leadId,
        phone,
        channel: 'whatsapp',
        direction: 'inbound',
        content,
        messageType,
        mediaUrl,
        sentBy: 'user',
        externalId: externalId ?? null,
      })
    } catch (err) {
      // Segunda camada (índice único parcial): corrida entre duas
      // requisições concorrentes que passaram pelo SELECT acima ao mesmo
      // tempo. Já processado, não é erro fatal.
      if (isUniqueViolation(err)) {
        console.log(`[WhatsApp Webhook] corrida no insert (unique violation), externalId=${externalId}, tratando como já processado`)
        return NextResponse.json({ ok: true, duplicate: true })
      }
      throw err
    }

    // Mensagem real trocada: se for a primeira, marca a abordagem do lead
    await markLeadContacted(leadId)

    // Resposta automática de IA (Fase 1): roda DEPOIS do 200 sair pra Meta,
    // nunca atrasa o webhook. Respeita o handoff humano (botPaused) e o gate
    // de aiSystemPrompt (dentro de generateAndSendAiReply).
    if (!lead.botPaused) {
      after(() =>
        generateAndSendAiReply(leadId).catch((err) => console.error('[AI Reply] erro no after() do webhook WhatsApp:', err)),
      )
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('whatsapp webhook error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
