import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { db } from '@/lib/db'
import { whatsappMessages, recoveryLeads, settings, messageJobs } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { checkWebhookToken } from '@/lib/webhook-auth'

function normalizePhone(raw: string): string {
  return raw.replace(/[@+\s\-().]/g, '').replace(/@.*$/, '').replace(/^0+/, '')
}

// Valida a assinatura x-hub-signature-256 da Meta sobre o raw body usando META_APP_SECRET
function verifyMetaSignature(rawBody: string, header: string | null): boolean {
  const secret = process.env.META_APP_SECRET
  if (!secret || !header) return false
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(header)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
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
    // Barreira propria (nosso token) ANTES de qualquer processamento.
    const auth = checkWebhookToken(req)
    if (!auth.ok) {
      return NextResponse.json({ error: auth.reason }, { status: auth.status })
    }

    const rawBody = await req.text()
    let body: Record<string, unknown>
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Payload inválido' }, { status: 400 })
    }

    const isMeta = body.object === 'whatsapp_business_account'

    if (isMeta) {
      // Falha fechada: payload Meta exige assinatura HMAC válida com META_APP_SECRET
      if (!verifyMetaSignature(rawBody, req.headers.get('x-hub-signature-256'))) {
        return NextResponse.json({ error: 'Assinatura inválida' }, { status: 401 })
      }
    } else {
      // UazAPI: exige instanceToken que case com uma empresa configurada
      const instanceToken = (body.instanceToken as string) || null
      if (!instanceToken) {
        return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
      }
      const [cfg] = await db.select().from(settings).where(eq(settings.uazapiInstanceToken, instanceToken))
      if (!cfg) {
        return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
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

    const [lead] = await db
      .select()
      .from(recoveryLeads)
      .where(and(eq(recoveryLeads.phone, phone), eq(recoveryLeads.companyId, companyId)))
      .limit(1)

    await db.insert(whatsappMessages).values({
      companyId,
      leadId: lead?.id ?? null,
      phone,
      direction: 'inbound',
      content,
      messageType,
      mediaUrl,
      sentBy: 'user',
      externalId: externalId ?? null,
    })

    if (lead && name && !lead.name) {
      await db.update(recoveryLeads).set({ name }).where(eq(recoveryLeads.id, lead.id))
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('whatsapp webhook error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
