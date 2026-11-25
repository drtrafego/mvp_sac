import { createHmac, timingSafeEqual } from 'node:crypto'
import { after } from 'next/server'
import { and, eq, sql } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { companies, recoveryLeads, sacAuditEvents, settings, whatsappMessages } from '@/lib/db/schema'
import { generateAndSendAiReply } from '@/lib/ai-reply'
import { markLeadContacted } from '@/lib/leads'
import { isUniqueViolation } from '@/lib/webhook-dedup'

export const runtime = 'nodejs'
export const maxDuration = 180
export const dynamic = 'force-dynamic'

const NARA_EMAIL = 'nara@casaldotrafego.email'
const AMANDA_COMPANY_ID = 498

type BrevoAddress = { Address?: unknown; Name?: unknown; address?: unknown; name?: unknown }
type BrevoItem = {
  From?: BrevoAddress | string
  To?: BrevoAddress | BrevoAddress[] | string | string[]
  Subject?: unknown
  MessageId?: unknown
  InReplyTo?: unknown
  References?: unknown
  ExtractedMarkdownMessage?: unknown
  RawTextBody?: unknown
  RawHtmlBody?: unknown
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function signatureOk(req: NextRequest, raw: string): boolean {
  const secret = process.env.BREVO_INBOUND_WEBHOOK_SECRET?.trim()
  if (!secret) return false
  const provided = req.headers.get('x-hub-signature-256')?.trim() || ''
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`
  return safeEqual(provided, expected)
}

function address(value: unknown): string {
  if (typeof value === 'string') {
    const match = value.match(/<([^>]+)>/) || value.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)
    return (match?.[1] ?? match?.[0] ?? '').trim().toLowerCase()
  }
  if (!value || typeof value !== 'object') return ''
  const item = value as BrevoAddress
  return String(item.Address ?? item.address ?? '').trim().toLowerCase()
}

function addresses(value: BrevoItem['To']): string[] {
  const values = Array.isArray(value) ? value : [value]
  return values.flatMap(item => {
    if (typeof item === 'string') return [address(item)].filter(Boolean)
    if (item && typeof item === 'object') return [address(item)].filter(Boolean)
    return []
  })
}

function displayName(value: BrevoItem['From']): string | null {
  if (!value || typeof value === 'string') return null
  const item = value as BrevoAddress
  const name = item.Name ?? item.name
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : null
}

function bodyOf(item: BrevoItem): string {
  const candidates = [item.ExtractedMarkdownMessage, item.RawTextBody, item.RawHtmlBody]
  const value = candidates.find(candidate => typeof candidate === 'string' && candidate.trim())
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim().slice(0, 20_000) : ''
}

function isOptOut(value: string): boolean {
  const normalized = value.trim().toLocaleLowerCase('pt-BR').replace(/[.!?]+$/g, '')
  return /^(sair|sa[ií]r|stop|unsubscribe|cancelar|ba[jx]a|no me interesa|não quero receber|nao quero receber)$/.test(normalized)
}

function jsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const raw = await req.text()
  if (!signatureOk(req, raw)) return jsonResponse({ error: 'invalid_signature' }, 401)
  if (slug !== 'amanda') return jsonResponse({ error: 'route_not_found' }, 404)

  let payload: { items?: BrevoItem[] }
  try { payload = JSON.parse(raw) as { items?: BrevoItem[] } } catch { return jsonResponse({ error: 'invalid_json' }, 400) }
  const item = Array.isArray(payload.items) ? payload.items[0] : undefined
  if (!item) return jsonResponse({ error: 'missing_item' }, 400)

  const fromEmail = address(item.From)
  const toEmails = addresses(item.To)
  const messageId = typeof item.MessageId === 'string' ? item.MessageId.trim().slice(0, 998) : ''
  const subject = typeof item.Subject === 'string' ? item.Subject.trim().slice(0, 998) : ''
  const content = bodyOf(item)
  if (!fromEmail || !messageId || !content) return jsonResponse({ error: 'missing_email_fields' }, 400)
  if (fromEmail === NARA_EMAIL || !toEmails.includes(NARA_EMAIL)) return jsonResponse({ ok: true, skipped: true })

  const [company] = await db.select().from(companies).where(and(eq(companies.id, AMANDA_COMPANY_ID), eq(companies.slug, 'amanda'))).limit(1)
  if (!company) return jsonResponse({ error: 'amanda_company_not_found' }, 503)
  const [config] = await db.select({ aiAgentKey: settings.aiAgentKey, aiSystemPrompt: settings.aiSystemPrompt }).from(settings).where(eq(settings.companyId, company.id)).limit(1)
  if (config?.aiAgentKey !== 'amanda' || !config.aiSystemPrompt) return jsonResponse({ error: 'amanda_ai_not_configured' }, 503)

  if (await db.select({ id: whatsappMessages.id }).from(whatsappMessages).where(and(
    eq(whatsappMessages.companyId, company.id), eq(whatsappMessages.channel, 'email'),
    eq(whatsappMessages.externalId, messageId), eq(whatsappMessages.direction, 'inbound'),
  )).limit(1).then(rows => Boolean(rows[0]))) return jsonResponse({ ok: true, duplicate: true })

  const phone = `email:${fromEmail}`
  let [lead] = await db.select().from(recoveryLeads).where(and(eq(recoveryLeads.companyId, company.id), eq(recoveryLeads.channel, 'email'), eq(recoveryLeads.email, fromEmail))).limit(1)
  if (!lead) {
    const inserted = await db.insert(recoveryLeads).values({
      companyId: company.id, platform: 'sac', eventType: 'atendimento', phone,
      name: displayName(item.From), email: fromEmail, channel: 'email', status: 'in_conversation',
      trackingSource: 'email_inbound',
    }).onConflictDoNothing({ target: [recoveryLeads.companyId, recoveryLeads.phone], targetWhere: sql`${recoveryLeads.platform} in ('instagram', 'sac', 'hermes', 'import_planilha')` }).returning()
    lead = inserted[0] ?? (await db.select().from(recoveryLeads).where(and(eq(recoveryLeads.companyId, company.id), eq(recoveryLeads.phone, phone))).limit(1))[0]
  }
  if (!lead) return jsonResponse({ error: 'lead_resolution_failed' }, 500)

  try {
    await db.insert(whatsappMessages).values({
      companyId: company.id, leadId: lead.id, phone, channel: 'email', direction: 'inbound',
      content, messageType: 'text', sentBy: 'user', senderName: displayName(item.From), externalId: messageId,
      reasoning: JSON.stringify({ emailSubject: subject, inReplyTo: item.InReplyTo ?? null, references: item.References ?? null, to: toEmails }),
    })
  } catch (error) {
    if (isUniqueViolation(error)) return jsonResponse({ ok: true, duplicate: true })
    throw error
  }
  await markLeadContacted(lead.id)
  await db.insert(sacAuditEvents).values({
    companyId: company.id, leadId: lead.id, type: 'email_received', actorType: 'system', actorId: 'brevo_inbound',
    actorName: 'Brevo Inbound Nara', referenceType: 'whatsapp_message', referenceId: messageId,
    payload: { channel: 'email', recipient: NARA_EMAIL, subject, inReplyTo: item.InReplyTo ?? null },
  }).catch(error => console.error('[Brevo inbound] audit failed', error))

  if (isOptOut(content)) {
    await db.update(recoveryLeads).set({ botPaused: true, botPausedAt: new Date(), botPausedBy: 'optout_email', updatedAt: new Date() }).where(and(eq(recoveryLeads.id, lead.id), eq(recoveryLeads.companyId, company.id)))
    await db.insert(sacAuditEvents).values({ companyId: company.id, leadId: lead.id, type: 'email_opted_out', actorType: 'system', actorId: 'brevo_inbound', referenceType: 'whatsapp_message', referenceId: messageId, payload: { channel: 'email' } }).catch(() => {})
    return jsonResponse({ ok: true, optedOut: true })
  }

  after(() => generateAndSendAiReply(lead.id).catch(error => console.error('[Brevo inbound] Amanda reply failed', error)))
  return jsonResponse({ ok: true, accepted: true })
}
