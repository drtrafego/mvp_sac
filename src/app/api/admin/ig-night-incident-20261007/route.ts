export const dynamic = 'force-dynamic'
export const maxDuration = 180

import { NextRequest, NextResponse } from 'next/server'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { companies, recoveryLeads, whatsappMessages, leadTags, webhookReceived } from '@/lib/db/schema'
import { generateAndSendAiReply } from '@/lib/ai-reply'

const KEY = 'ig_night_20261007_Q3p9vL'
function authorized(req: NextRequest): boolean { return new URL(req.url).searchParams.get('key') === KEY }

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const url = new URL(req.url)
  const phone = url.searchParams.get('phone')?.trim() || null
  const since = url.searchParams.get('since') || '2026-10-06T21:00:00Z'
  const until = url.searchParams.get('until') || '2026-10-07T12:00:00Z'

  const recentWebhooks = await db
    .select({ id: webhookReceived.id, companyId: webhookReceived.companyId, slug: webhookReceived.slug, source: webhookReceived.source, event: webhookReceived.event, processed: webhookReceived.processed, skipReason: webhookReceived.skipReason, errorMessage: webhookReceived.errorMessage, leadId: webhookReceived.leadId, receivedAt: webhookReceived.receivedAt, rawBody: webhookReceived.rawBody })
    .from(webhookReceived)
    .where(and(eq(webhookReceived.source, 'instagram'), sql`${webhookReceived.receivedAt} >= ${since}::timestamptz`, sql`${webhookReceived.receivedAt} <= ${until}::timestamptz`))
    .orderBy(desc(webhookReceived.receivedAt))
    .limit(100)

  const phonesFromRecentWebhooks = Array.from(new Set(recentWebhooks.flatMap((webhook) => {
    const raw = webhook.rawBody as { messaging?: Array<{ sender?: { id?: string }, recipient?: { id?: string }, message?: { is_echo?: boolean, text?: string, attachments?: Array<{ type?: string }>, referral?: unknown }, referral?: unknown }> } | null
    return (raw?.messaging || []).flatMap((item) => {
      const ids: string[] = []
      if (item.sender?.id) ids.push(`ig_${item.sender.id}`)
      if (item.recipient?.id) ids.push(`ig_${item.recipient.id}`)
      return ids
    })
  }).filter((value): value is string => Boolean(value))))

  const rows = await db
    .select({
      leadId: recoveryLeads.id,
      companyId: companies.id,
      companyName: companies.name,
      companySlug: companies.slug,
      phone: recoveryLeads.phone,
      name: recoveryLeads.name,
      channel: recoveryLeads.channel,
      platform: recoveryLeads.platform,
      trackingSource: recoveryLeads.trackingSource,
      botPaused: recoveryLeads.botPaused,
      createdAt: recoveryLeads.createdAt,
      updatedAt: recoveryLeads.updatedAt,
      lastActionAt: recoveryLeads.lastActionAt,
      inboundCount: sql<number>`cast(count(${whatsappMessages.id}) filter (where ${whatsappMessages.direction} = 'inbound') as int)`,
      outboundCount: sql<number>`cast(count(${whatsappMessages.id}) filter (where ${whatsappMessages.direction} = 'outbound') as int)`,
      lastInboundAt: sql<Date | null>`max(${whatsappMessages.createdAt}) filter (where ${whatsappMessages.direction} = 'inbound')`,
      lastOutboundAt: sql<Date | null>`max(${whatsappMessages.createdAt}) filter (where ${whatsappMessages.direction} = 'outbound')`,
      lastInboundText: sql<string | null>`(array_agg(${whatsappMessages.content} order by ${whatsappMessages.createdAt} desc) filter (where ${whatsappMessages.direction} = 'inbound'))[1]`,
      lastOutboundText: sql<string | null>`(array_agg(${whatsappMessages.content} order by ${whatsappMessages.createdAt} desc) filter (where ${whatsappMessages.direction} = 'outbound'))[1]`,
      tags: sql<string[]>`coalesce(array_agg(distinct ${leadTags.tag}) filter (where ${leadTags.tag} is not null), '{}')`,
    })
    .from(recoveryLeads)
    .innerJoin(companies, eq(companies.id, recoveryLeads.companyId))
    .leftJoin(whatsappMessages, and(eq(whatsappMessages.companyId, recoveryLeads.companyId), eq(whatsappMessages.leadId, recoveryLeads.id)))
    .leftJoin(leadTags, eq(leadTags.leadId, recoveryLeads.id))
    .where(and(
      sql`(${recoveryLeads.channel} = 'instagram' or ${recoveryLeads.platform} ilike '%instagram%' or ${recoveryLeads.phone} like 'ig_%')`,
      phone ? eq(recoveryLeads.phone, phone) : or(inArray(recoveryLeads.phone, phonesFromRecentWebhooks.length ? phonesFromRecentWebhooks : ['__none__']), sql`${recoveryLeads.updatedAt} >= ${since}::timestamptz`),
    ))
    .groupBy(recoveryLeads.id, companies.id)
    .orderBy(desc(sql`coalesce(max(${whatsappMessages.createdAt}), ${recoveryLeads.updatedAt}, ${recoveryLeads.createdAt})`))
    .limit(100)

  return NextResponse.json({ marker: 'ig-night-incident-20261007', since, until, phonesFromRecentWebhooks, webhooks: recentWebhooks, rows })
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as { leadId?: number, webhookId?: number }
  const directLeadId = Number(body.leadId)
  if (Number.isInteger(directLeadId) && directLeadId > 0) {
    await generateAndSendAiReply(directLeadId)
    return NextResponse.json({ ok: true, leadId: directLeadId })
  }

  const webhookId = Number(body.webhookId)
  if (!Number.isInteger(webhookId) || webhookId <= 0) return NextResponse.json({ error: 'leadId ou webhookId inválido' }, { status: 400 })

  const [webhook] = await db.select().from(webhookReceived).where(eq(webhookReceived.id, webhookId)).limit(1)
  if (!webhook || !webhook.companyId) return NextResponse.json({ error: 'webhook não encontrado ou sem empresa' }, { status: 404 })

  const raw = webhook.rawBody as { messaging?: Array<{ sender?: { id?: string }, message?: { mid?: string, text?: string, is_echo?: boolean, attachments?: Array<{ type?: string }>, referral?: Record<string, unknown> }, referral?: Record<string, unknown> }> } | null
  const item = raw?.messaging?.[0]
  const senderId = item?.sender?.id
  const message = item?.message
  if (!senderId || !message || message.is_echo) return NextResponse.json({ error: 'webhook sem mensagem inbound válida' }, { status: 400 })

  const attachmentTypes = (message.attachments || []).map((a) => a.type || 'unknown')
  const hasAudioAttachment = attachmentTypes.includes('audio')
  const referral = (item.referral || message.referral) as { ad_id?: string, source?: string, ads_context_data?: { ad_id?: string, ad_title?: string } } | undefined
  const isAd = Boolean(referral && (referral.source === 'ADS' || referral.ad_id || referral.ads_context_data?.ad_id))
  const inboundText = (message.text || '').trim() || (hasAudioAttachment ? 'Recebi um áudio no Instagram.' : '') || (isAd ? 'Vim do anúncio do Instagram e quero saber mais.' : '')
  if (!inboundText) return NextResponse.json({ error: 'webhook sem texto processável' }, { status: 400 })

  const igPhone = `ig_${senderId}`
  const [lead] = await db.insert(recoveryLeads).values({
    companyId: webhook.companyId,
    platform: 'instagram',
    channel: 'instagram',
    eventType: 'instagram_direct',
    phone: igPhone,
    name: `Instagram Direct (${senderId.slice(-4)})`,
    status: 'in_conversation',
    trackingSource: isAd ? 'instagram_ad' : 'instagram_direct',
  }).onConflictDoUpdate({
    target: [recoveryLeads.companyId, recoveryLeads.phone],
    targetWhere: sql`${recoveryLeads.platform} in ('instagram', 'sac', 'hermes', 'import_planilha')`,
    set: { updatedAt: new Date(), lastActionAt: new Date(), channel: 'instagram', ...(isAd ? { trackingSource: 'instagram_ad' } : {}) },
  }).returning()

  if (isAd && lead?.id) {
    await db.insert(leadTags).values({ leadId: lead.id, tag: 'anuncio', scopeChannel: 'instagram', createdBy: 'system:instagram_ad' }).onConflictDoNothing()
  }

  await db.insert(whatsappMessages).values({
    companyId: webhook.companyId,
    leadId: lead?.id ?? null,
    phone: igPhone,
    channel: 'instagram',
    direction: 'inbound',
    content: inboundText,
    messageType: hasAudioAttachment ? 'audio' : 'text',
    sentBy: 'user',
    externalId: message.mid ?? null,
  }).onConflictDoNothing()

  if (lead?.id && !lead.botPaused) await generateAndSendAiReply(lead.id)
  return NextResponse.json({ ok: true, webhookId, leadId: lead?.id, phone: igPhone, inboundText })
}
