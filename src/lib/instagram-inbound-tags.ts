import { and, eq, sql } from 'drizzle-orm'
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
  settings: { instagramAccountId?: string | null; instagramPageId?: string | null },
): boolean {
  if (typeof entryId !== 'string' || !entryId.trim()) return false
  const acceptedIds = [settings.instagramAccountId, settings.instagramPageId]
    .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
    .map(id => id.trim())
  return acceptedIds.includes(entryId.trim())
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
