import { and, desc, eq, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { whatsappMessages } from '@/lib/db/schema'

export const INBOX_MESSAGE_PAGE_SIZE = 75
export const INBOX_MESSAGE_PAGE_SIZE_MAX = 100

type MessageCursor = { at: string; id: number }

export interface InboxMessagePageOptions {
  companyId: number
  leadId: number
  phone: string
  before?: string | null
  limit?: number
}

export interface InboxMessageRow {
  id: number
  phone: string
  channel: string | null
  direction: string
  content: string | null
  messageType: string | null
  mediaUrl: string | null
  sentBy: string | null
  reasoning: string | null
  sentEmail: string | null
  createdAt: Date | null
}

export interface InboxMessagePage {
  messages: InboxMessageRow[]
  nextCursor: string | null
  hasMore: boolean
}

function encodeMessageCursor(cursor: MessageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeMessageCursor(value: string | null | undefined): MessageCursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<MessageCursor>
    if (typeof parsed.at !== 'string' || !Number.isInteger(parsed.id) || !Number.isFinite(Date.parse(parsed.at))) {
      return null
    }
    return { at: parsed.at, id: parsed.id! }
  } catch {
    return null
  }
}

export async function loadInboxMessagePage(options: InboxMessagePageOptions): Promise<InboxMessagePage> {
  const limit = Math.min(INBOX_MESSAGE_PAGE_SIZE_MAX, Math.max(1, options.limit ?? INBOX_MESSAGE_PAGE_SIZE))
  const cursor = decodeMessageCursor(options.before)
  const cleanPhone = options.phone.replace(/\D/g, '')
  const messageAt = sql<Date>`coalesce(${whatsappMessages.createdAt}, '1970-01-01'::timestamp)`

  const participants = or(
    eq(whatsappMessages.leadId, options.leadId),
    options.phone ? eq(whatsappMessages.phone, options.phone) : undefined,
    cleanPhone && cleanPhone !== options.phone ? eq(whatsappMessages.phone, cleanPhone) : undefined,
  )!

  const conditions = [eq(whatsappMessages.companyId, options.companyId), participants]
  if (cursor) {
    conditions.push(or(
      sql`${messageAt} < ${cursor.at}::timestamp`,
      and(sql`${messageAt} = ${cursor.at}::timestamp`, sql`${whatsappMessages.id} < ${cursor.id}`),
    )!)
  }

  const rows = await db
    .select({
      id: whatsappMessages.id,
      phone: whatsappMessages.phone,
      channel: whatsappMessages.channel,
      direction: whatsappMessages.direction,
      content: whatsappMessages.content,
      messageType: whatsappMessages.messageType,
      mediaUrl: whatsappMessages.mediaUrl,
      sentBy: whatsappMessages.sentBy,
      reasoning: whatsappMessages.reasoning,
      sentEmail: whatsappMessages.sentEmail,
      createdAt: whatsappMessages.createdAt,
      messageAt,
    })
    .from(whatsappMessages)
    .where(and(...conditions))
    .orderBy(desc(messageAt), desc(whatsappMessages.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const pageRows = (hasMore ? rows.slice(0, limit) : rows).reverse()
  const oldest = pageRows[0]
  const oldestAt = oldest ? new Date(String(oldest.messageAt)) : null

  return {
    messages: pageRows.map(message => ({
      id: message.id,
      phone: message.phone,
      channel: message.channel,
      direction: message.direction,
      content: message.content,
      messageType: message.messageType,
      mediaUrl: message.mediaUrl,
      sentBy: message.sentBy,
      reasoning: message.reasoning,
      sentEmail: message.sentEmail,
      createdAt: message.createdAt,
    })),
    hasMore,
    nextCursor: hasMore && oldest && oldestAt && !Number.isNaN(oldestAt.getTime())
      ? encodeMessageCursor({ at: oldestAt.toISOString(), id: oldest.id })
      : null,
  }
}
