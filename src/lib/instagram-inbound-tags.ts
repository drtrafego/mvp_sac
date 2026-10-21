import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { instagramInboundTagRules, leadTags, whatsappMessages } from '@/lib/db/schema'
import { matchesCommentKeywords } from '@/lib/instagram-comment-keywords'
import { normalizeTag } from '@/lib/lead-tags'

export type InstagramInboundTagTrigger = 'direct' | 'story_reply'
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type TagExecutor = typeof db | Transaction

export class InstagramInboundPersistenceError extends Error {
  constructor(cause: unknown) {
    super('Não foi possível persistir atomicamente a mensagem e suas tags do Instagram.')
    this.name = 'InstagramInboundPersistenceError'
    this.cause = cause
  }
}

export function isInstagramStoryReply(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const record = message as Record<string, unknown>
  const replyTo = record.reply_to
  if (!replyTo || typeof replyTo !== 'object') return false
  const reply = replyTo as Record<string, unknown>
  return Boolean(reply.story_id || (reply.story && typeof reply.story === 'object'))
}

export function getInstagramInboundTagTriggers(isStoryReply: boolean): InstagramInboundTagTrigger[] {
  return isStoryReply ? ['story_reply'] : ['direct']
}

export async function applyInstagramInboundTagRules(input: {
  companyId: number
  leadId: number
  text: string
  isStoryReply: boolean
  executor?: TagExecutor
}): Promise<{ matched: string[]; applied: string[] }> {
  const { companyId, leadId, text, isStoryReply } = input
  const executor = input.executor ?? db
  const triggers = getInstagramInboundTagTriggers(isStoryReply)
  const rules = await executor
    .select()
    .from(instagramInboundTagRules)
    .where(and(eq(instagramInboundTagRules.companyId, companyId), eq(instagramInboundTagRules.isActive, true)))

  const matched: string[] = []
  const applied: string[] = []
  for (const rule of rules) {
    if (!triggers.includes(rule.trigger as InstagramInboundTagTrigger)) continue
    const result = matchesCommentKeywords(text, rule.keywords, rule.matchType)
    if (!result.matched) continue
    const tag = normalizeTag(rule.tag)
    if (!tag) continue
    matched.push(tag)
    const inserted = await executor.insert(leadTags).values({
      leadId,
      tag,
      scopeChannel: 'instagram',
      createdBy: `automation:instagram:${rule.trigger}`,
    }).onConflictDoNothing().returning({ id: leadTags.id })
    if (inserted.length) applied.push(tag)
  }
  return { matched, applied }
}

export async function persistInstagramInboundWithTags({
  companyId,
  leadId,
  text,
  isStoryReply,
  message,
}: {
  companyId: number
  leadId: number
  text: string
  isStoryReply: boolean
  message: typeof whatsappMessages.$inferInsert
}) {
  try {
    return await db.transaction(async tx => {
      const tagResult = await applyInstagramInboundTagRules({ companyId, leadId, text, isStoryReply, executor: tx })
      await tx.insert(whatsappMessages).values(message)
      return tagResult
    })
  } catch (error) {
    throw new InstagramInboundPersistenceError(error)
  }
}
