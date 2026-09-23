import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import { db } from '@/lib/db'
import { recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { channelWhereCondition, normalizePhoneDigits } from '@/lib/inbox-channel-filter'
import { isDirectOrganicSourceFilter, normalizeInboxSourceFilter } from '@/lib/inbox-source-filter'
import { getEmailEngagement, type EmailEngagement } from '@/lib/email-engagement'

export const INBOX_PAGE_SIZE = 75
export const INBOX_PAGE_SIZE_MAX = 100

export interface ConversationSummary {
  id: number
  phone: string
  name: string | null
  email?: string | null
  eventType: string
  status: string | null
  productName: string | null
  productValue?: number | null
  platform?: string | null
  channel?: string | null
  botPaused?: boolean
  botPausedAt?: string | null
  botPausedBy?: string | null
  trackingSource?: string | null
  utmCampaign?: string | null
  allOrigins?: string[]
  allEventTypes?: string[]
  lastMessage: string | null
  lastDirection: string | null
  lastMessageAt: string | null
  lastInboundAt?: string | null
  lastOutboundAt?: string | null
  createdAt?: string | null
  unread: number
  emailEngagement?: EmailEngagement | null
}

export interface InboxPage {
  conversations: ConversationSummary[]
  nextCursor: string | null
  hasMore: boolean
}

export interface InboxPageOptions {
  companyId: number
  channel?: string | null
  source?: string | null
  status?: string | null
  query?: string | null
  cursor?: string | null
  limit?: number
}

type Cursor = { at: string; id: number }

const activityAt = sql<Date>`COALESCE(${recoveryLeads.lastActionAt}, ${recoveryLeads.updatedAt}, ${recoveryLeads.createdAt})`

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeInboxCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<Cursor>
    if (typeof parsed.at !== 'string' || !Number.isInteger(parsed.id) || !Number.isFinite(Date.parse(parsed.at))) {
      return null
    }
    return { at: parsed.at, id: parsed.id! }
  } catch {
    return null
  }
}

export async function loadInboxPage(options: InboxPageOptions): Promise<InboxPage> {
  const limit = Math.min(INBOX_PAGE_SIZE_MAX, Math.max(1, options.limit ?? INBOX_PAGE_SIZE))
  const sourceFilter = normalizeInboxSourceFilter(options.source)
  const cursor = decodeInboxCursor(options.cursor)
  const whereConditions: SQL[] = [eq(recoveryLeads.companyId, options.companyId)]

  const channelCondition = channelWhereCondition(options.channel)
  if (channelCondition) whereConditions.push(channelCondition)

  if (sourceFilter) {
    whereConditions.push(
      isDirectOrganicSourceFilter(sourceFilter)
        ? sql`coalesce(nullif(${recoveryLeads.trackingSource}, ''), nullif(${recoveryLeads.platform}, '')) is null`
        : sql`(${recoveryLeads.trackingSource} ILIKE ${'%' + sourceFilter + '%'} OR ${recoveryLeads.platform} ILIKE ${'%' + sourceFilter + '%'})`
    )
  }

  if (options.status === 'paused') whereConditions.push(eq(recoveryLeads.botPaused, true))
  if (options.status === 'active') whereConditions.push(sql`coalesce(${recoveryLeads.botPaused}, false) = false`)
  if (options.status === 'unread') {
    whereConditions.push(sql`exists (
      select 1 from whatsapp_messages inbox_unread
      where inbox_unread.company_id = ${options.companyId}
        and inbox_unread.lead_id = ${recoveryLeads.id}
        and inbox_unread.direction = 'inbound'
    )`)
  }

  const query = options.query?.trim()
  if (query) {
    const pattern = `%${query}%`
    const phoneDigits = normalizePhoneDigits(query)
    const searchConditions: SQL[] = [
      sql`${recoveryLeads.name} ILIKE ${pattern}`,
      sql`${recoveryLeads.email} ILIKE ${pattern}`,
      sql`${recoveryLeads.productName} ILIKE ${pattern}`,
      sql`exists (
        select 1 from whatsapp_messages inbox_search
        where inbox_search.company_id = ${options.companyId}
          and (inbox_search.lead_id = ${recoveryLeads.id} or inbox_search.phone = ${recoveryLeads.phone})
          and inbox_search.content ILIKE ${pattern}
      )`,
    ]
    if (phoneDigits) {
      searchConditions.push(sql`regexp_replace(${recoveryLeads.phone}, '\\D', '', 'g') LIKE ${'%' + phoneDigits + '%'}`)
    }
    whereConditions.push(or(...searchConditions)!)
  }

  if (cursor) {
    whereConditions.push(
      or(
        sql`${activityAt} < ${cursor.at}::timestamp`,
        and(sql`${activityAt} = ${cursor.at}::timestamp`, sql`${recoveryLeads.id} < ${cursor.id}`)
      )!
    )
  }

  const leadRows = await db
    .select({
      id: recoveryLeads.id,
      phone: recoveryLeads.phone,
      name: recoveryLeads.name,
      email: recoveryLeads.email,
      eventType: recoveryLeads.eventType,
      status: recoveryLeads.status,
      productName: recoveryLeads.productName,
      productValue: recoveryLeads.productValue,
      platform: recoveryLeads.platform,
      channel: recoveryLeads.channel,
      botPaused: recoveryLeads.botPaused,
      botPausedAt: recoveryLeads.botPausedAt,
      botPausedBy: recoveryLeads.botPausedBy,
      trackingSource: recoveryLeads.trackingSource,
      utmCampaign: recoveryLeads.utmCampaign,
      createdAt: recoveryLeads.createdAt,
      updatedAt: recoveryLeads.updatedAt,
      miningTags: recoveryLeads.miningTags,
      activityAt,
    })
    .from(recoveryLeads)
    .where(and(...whereConditions))
    .orderBy(desc(activityAt), desc(recoveryLeads.id))
    .limit(limit + 1)

  const hasMore = leadRows.length > limit
  const leads = hasMore ? leadRows.slice(0, limit) : leadRows
  if (leads.length === 0) return { conversations: [], nextCursor: null, hasMore: false }

  const leadIds = leads.map(lead => lead.id)
  const phones = leads.map(lead => lead.phone).filter((phone): phone is string => Boolean(phone?.trim()))

  const [lastMessageByLeadId, lastMessageByPhone, unreadRows] = await Promise.all([
    db
      .selectDistinctOn([whatsappMessages.leadId], {
        leadId: whatsappMessages.leadId,
        direction: whatsappMessages.direction,
        content: whatsappMessages.content,
        createdAt: whatsappMessages.createdAt,
      })
      .from(whatsappMessages)
      .where(and(eq(whatsappMessages.companyId, options.companyId), inArray(whatsappMessages.leadId, leadIds)))
      .orderBy(whatsappMessages.leadId, desc(whatsappMessages.createdAt)),
    phones.length > 0
      ? db
          .selectDistinctOn([whatsappMessages.phone], {
            phone: whatsappMessages.phone,
            direction: whatsappMessages.direction,
            content: whatsappMessages.content,
            createdAt: whatsappMessages.createdAt,
          })
          .from(whatsappMessages)
          .where(and(eq(whatsappMessages.companyId, options.companyId), inArray(whatsappMessages.phone, phones)))
          .orderBy(whatsappMessages.phone, desc(whatsappMessages.createdAt))
      : Promise.resolve([]),
    db
      .select({ leadId: whatsappMessages.leadId, count: sql<number>`count(*)::int` })
      .from(whatsappMessages)
      .where(and(
        eq(whatsappMessages.companyId, options.companyId),
        eq(whatsappMessages.direction, 'inbound'),
        inArray(whatsappMessages.leadId, leadIds)
      ))
      .groupBy(whatsappMessages.leadId),
  ])

  const msgByLead = new Map(lastMessageByLeadId.flatMap(message => message.leadId == null ? [] : [[message.leadId, message] as const]))
  const msgByPhone = new Map(lastMessageByPhone.flatMap(message => message.phone ? [[message.phone, message] as const] : []))
  const unreadCountByLead = new Map(unreadRows.flatMap(row => row.leadId == null ? [] : [[row.leadId, row.count] as const]))

  const conversations = leads.map((lead): ConversationSummary => {
    const lastMessage = msgByLead.get(lead.id) || msgByPhone.get(lead.phone)
    return {
      id: lead.id,
      phone: lead.phone,
      name: lead.name,
      email: lead.email,
      eventType: lead.eventType,
      status: lead.status,
      productName: lead.productName,
      productValue: lead.productValue,
      platform: lead.platform,
      channel: lead.channel || 'whatsapp',
      botPaused: lead.botPaused ?? false,
      botPausedAt: lead.botPausedAt?.toISOString() ?? null,
      botPausedBy: lead.botPausedBy,
      trackingSource: lead.trackingSource,
      utmCampaign: lead.utmCampaign,
      createdAt: lead.createdAt?.toISOString() ?? null,
      lastMessage: lastMessage?.content ?? null,
      lastDirection: lastMessage?.direction ?? null,
      lastMessageAt: lastMessage?.createdAt?.toISOString() ?? lead.updatedAt?.toISOString() ?? null,
      lastInboundAt: lastMessage?.direction === 'inbound' ? lastMessage.createdAt?.toISOString() ?? null : null,
      lastOutboundAt: lastMessage?.direction === 'outbound' ? lastMessage.createdAt?.toISOString() ?? null : null,
      unread: unreadCountByLead.get(lead.id) ?? 0,
      emailEngagement: getEmailEngagement(lead.miningTags),
    }
  })

  const last = leads.at(-1)!
  const lastActivityAt = last.activityAt instanceof Date ? last.activityAt.toISOString() : String(last.activityAt)
  return {
    conversations,
    hasMore,
    nextCursor: hasMore && Number.isFinite(Date.parse(lastActivityAt))
      ? encodeCursor({ at: lastActivityAt, id: last.id })
      : null,
  }
}
