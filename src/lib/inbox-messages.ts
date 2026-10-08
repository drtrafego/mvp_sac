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
  aroundMessageId?: number | null
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
  sendState: string | null
  sendError: string | null
  clientRequestId: string | null
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

  // SAC Lote 1: Se solicitado salto direto para uma mensagem de busca, carregar uma janela centrada nela
  if (options.aroundMessageId && !cursor) {
    const [target] = await db
      .select({ id: whatsappMessages.id, createdAt: whatsappMessages.createdAt })
      .from(whatsappMessages)
      .where(and(eq(whatsappMessages.id, options.aroundMessageId), eq(whatsappMessages.companyId, options.companyId), participants))

    if (target) {
      const half = Math.floor(limit / 2)
      const targetDate = target.createdAt ?? new Date('1970-01-01')

      const olderRows = await db
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
          sendState: whatsappMessages.sendState,
          sendError: whatsappMessages.sendError,
          clientRequestId: whatsappMessages.clientRequestId,
          createdAt: whatsappMessages.createdAt,
          messageAt,
        })
        .from(whatsappMessages)
        .where(
          and(
            eq(whatsappMessages.companyId, options.companyId),
            participants,
            or(
              sql`${messageAt} < ${targetDate.toISOString()}::timestamp`,
              and(sql`${messageAt} = ${targetDate.toISOString()}::timestamp`, sql`${whatsappMessages.id} <= ${target.id}`)
            )!
          )
        )
        .orderBy(desc(messageAt), desc(whatsappMessages.id))
        .limit(half + 1)

      const hasOlder = olderRows.length > half
      const olderPage = hasOlder ? olderRows.slice(0, half) : olderRows

      const newerRows = await db
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
          sendState: whatsappMessages.sendState,
          sendError: whatsappMessages.sendError,
          clientRequestId: whatsappMessages.clientRequestId,
          createdAt: whatsappMessages.createdAt,
          messageAt,
        })
        .from(whatsappMessages)
        .where(
          and(
            eq(whatsappMessages.companyId, options.companyId),
            participants,
            or(
              sql`${messageAt} > ${targetDate.toISOString()}::timestamp`,
              and(sql`${messageAt} = ${targetDate.toISOString()}::timestamp`, sql`${whatsappMessages.id} > ${target.id}`)
            )!
          )
        )
        .orderBy(sql`${messageAt} asc`, sql`${whatsappMessages.id} asc`)
        .limit(half)

      const combined = [...olderPage.reverse(), ...newerRows]
      const oldest = combined[0]
      const oldestAt = oldest ? new Date(String(oldest.messageAt)) : null

      return {
        messages: combined.map((m) => ({
          id: m.id,
          phone: m.phone,
          channel: m.channel,
          direction: m.direction,
          content: m.content,
          messageType: m.messageType,
          mediaUrl: m.mediaUrl,
          sentBy: m.sentBy,
          reasoning: m.reasoning,
          sentEmail: m.sentEmail,
          sendState: m.sendState,
          sendError: m.sendError,
          clientRequestId: m.clientRequestId,
          createdAt: m.createdAt,
        })),
        hasMore: hasOlder,
        nextCursor: hasOlder && oldest && oldestAt && !Number.isNaN(oldestAt.getTime())
          ? encodeMessageCursor({ at: oldestAt.toISOString(), id: oldest.id })
          : null,
      }
    }
  }

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
      sendState: whatsappMessages.sendState,
      sendError: whatsappMessages.sendError,
      clientRequestId: whatsappMessages.clientRequestId,
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
      sendState: message.sendState,
      sendError: message.sendError,
      clientRequestId: message.clientRequestId,
      createdAt: message.createdAt,
    })),
    hasMore,
    nextCursor: hasMore && oldest && oldestAt && !Number.isNaN(oldestAt.getTime())
      ? encodeMessageCursor({ at: oldestAt.toISOString(), id: oldest.id })
      : null,
  }
}
