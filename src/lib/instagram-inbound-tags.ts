import { and, eq, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { db } from '@/lib/db'
import { instagramInboundTagRules, leadTags, recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { matchesCommentKeywords } from '@/lib/instagram-comment-keywords'
import { normalizeTag } from '@/lib/lead-tags'

export type InstagramInboundTagTrigger = 'direct' | 'story_reply'
export type InstagramInboundInteraction = 'comment' | 'direct' | 'story_reply' | 'story_reaction'
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type TagExecutor = typeof db | Transaction

const TAG_BY_INTERACTION: Record<InstagramInboundInteraction, string> = {
  comment: 'instagram_comentario',
  direct: 'instagram_direct',
  story_reply: 'instagram_resposta_story',
  story_reaction: 'instagram_reacao_story',
}

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
  if (record.is_story_reply === true) return true
  const replyTo = record.reply_to
  if (!replyTo || typeof replyTo !== 'object' || Array.isArray(replyTo)) return false
  const reply = replyTo as Record<string, unknown>
  return Boolean(reply.story || reply.story_id || reply.storyId)
}

export function isInstagramStoryReaction(value: Record<string, unknown> | undefined): boolean {
  if (!value) return false
  if (value.story || value.story_id || value.storyId) return true

  const message = value.message
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    return isInstagramStoryReply(message as Record<string, unknown>)
  }

  const reaction = value.reaction
  if (reaction && typeof reaction === 'object' && !Array.isArray(reaction)) {
    const reactionData = reaction as Record<string, unknown>
    return Boolean(reactionData.story || reactionData.story_id || reactionData.storyId)
  }
  return false
}

export function isInstagramEntryForCompany(
  entryId: unknown,
  settings: { instagramAccountId?: string | null },
): boolean {
  if (typeof entryId !== 'string' || !entryId.trim()) return false
  const instagramAccountId = settings.instagramAccountId?.trim()
  return Boolean(instagramAccountId && instagramAccountId === entryId.trim())
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
  const matched = await findInstagramInboundTags({ companyId, text, isStoryReply, executor })
  const applied: string[] = []

  for (const { tag, trigger } of matched) {
    const inserted = await executor.insert(leadTags).values({
      leadId,
      tag,
      scopeChannel: 'instagram',
      createdBy: `automation:instagram:${trigger}`,
    }).onConflictDoNothing().returning({ id: leadTags.id })
    if (inserted.length) applied.push(tag)
  }
  return { matched: matched.map(({ tag }) => tag), applied }
}

async function findInstagramInboundTags({
  companyId,
  text,
  isStoryReply,
  executor,
}: {
  companyId: number
  text: string
  isStoryReply: boolean
  executor: TagExecutor
}): Promise<Array<{ tag: string; trigger: InstagramInboundTagTrigger }>> {
  const triggers = getInstagramInboundTagTriggers(isStoryReply)
  const rules = await executor
    .select()
    .from(instagramInboundTagRules)
    .where(and(eq(instagramInboundTagRules.companyId, companyId), eq(instagramInboundTagRules.isActive, true)))

  const matched: Array<{ tag: string; trigger: InstagramInboundTagTrigger }> = []
  for (const rule of rules) {
    const trigger = rule.trigger as InstagramInboundTagTrigger
    if (!triggers.includes(trigger)) continue
    const result = matchesCommentKeywords(text, rule.keywords, rule.matchType)
    if (!result.matched) continue
    const tag = normalizeTag(rule.tag)
    if (!tag) continue
    matched.push({ tag, trigger })
  }
  return matched
}

export async function applyInstagramInboundTag(
  leadId: number | null | undefined,
  interaction: InstagramInboundInteraction,
): Promise<void> {
  if (!leadId) return
  await db.insert(leadTags).values({
    leadId,
    tag: TAG_BY_INTERACTION[interaction],
    scopeChannel: 'instagram',
    createdBy: `system:instagram_${interaction}`,
  }).onConflictDoNothing()
}

export async function captureInstagramInboundInteraction({
  companyId,
  instagramUserId,
  username,
  interaction,
}: {
  companyId: number
  instagramUserId: string
  username?: string | null
  interaction: InstagramInboundInteraction
}): Promise<number | null> {
  const cleanUserId = instagramUserId.trim().replace(/^ig_/, '')
  if (!cleanUserId) return null

  const phone = `ig_${cleanUserId}`
  const name = username?.trim() ? `@${username.trim().replace(/^@/, '')}` : `Instagram (${cleanUserId.slice(-4)})`
  const now = new Date()
  const [lead] = await db.insert(recoveryLeads).values({
    companyId,
    platform: 'instagram',
    channel: 'instagram',
    eventType: `instagram_${interaction}`,
    phone,
    name,
    status: 'in_conversation',
    trackingSource: 'instagram',
    lastActionAt: now,
  }).onConflictDoUpdate({
    target: [recoveryLeads.companyId, recoveryLeads.phone],
    targetWhere: sql`${recoveryLeads.platform} in ('instagram', 'sac', 'hermes', 'import_planilha')`,
    set: { updatedAt: now, lastActionAt: now, channel: 'instagram' },
  }).returning({ id: recoveryLeads.id })

  await applyInstagramInboundTag(lead?.id, interaction)
  return lead?.id ?? null
}

export async function persistInstagramInboundWithTags({
  companyId,
  leadId,
  text,
  isStoryReply,
  additionalTags = [],
  message,
}: {
  companyId: number
  leadId: number
  text: string
  isStoryReply: boolean
  additionalTags?: Array<{ tag: string; createdBy: string }>
  message: typeof whatsappMessages.$inferInsert
}) {
  try {
    const matched = await findInstagramInboundTags({ companyId, text, isStoryReply, executor: db })
    const ruleTags = matched.map(({ tag, trigger }) => ({
      tag,
      createdBy: `automation:instagram:${trigger}`,
    }))
    const tagValues = [...additionalTags, ...ruleTags]
      .map(({ tag, createdBy }) => ({
        leadId,
        tag: normalizeTag(tag),
        scopeChannel: 'instagram' as const,
        createdBy,
      }))
      .filter(({ tag }) => Boolean(tag))
    const tagStatements = tagValues.map((value) => db.insert(leadTags).values({
      ...value,
    }).onConflictDoNothing().returning({ id: leadTags.id }))
    // The unique inbound external_id index is the database-level idempotency
    // gate for concurrent Meta retries. A duplicate is success: tags remain
    // deduplicated by their own unique index and no second message is made.
    const messageStatement = db.insert(whatsappMessages).values(message).onConflictDoNothing()

    if (typeof db.batch === 'function') {
      const statements = [...tagStatements, messageStatement] as unknown as readonly [
        BatchItem<'pg'>,
        ...BatchItem<'pg'>[],
      ]
      const results = await db.batch(statements)
      const applied = tagValues
        .map(({ tag }, index) => results[index]?.length ? tag : null)
        .filter((tag): tag is string => Boolean(tag))
      return { matched: matched.map(({ tag }) => tag), applied }
    }

    // Keeps alternate drivers and the unit-test double working. Production uses neon-http above.
    return await db.transaction(async tx => {
      const tagResult = await applyInstagramInboundTagRules({ companyId, leadId, text, isStoryReply, executor: tx })
      for (const { tag, createdBy } of additionalTags) {
        await tx.insert(leadTags).values({ leadId, tag: normalizeTag(tag), scopeChannel: 'instagram', createdBy }).onConflictDoNothing()
      }
      await tx.insert(whatsappMessages).values(message).onConflictDoNothing()
      return { ...tagResult, applied: [...tagResult.applied, ...additionalTags.map(({ tag }) => normalizeTag(tag)).filter(Boolean)] }
    })
  } catch (error) {
    throw new InstagramInboundPersistenceError(error)
  }
}
