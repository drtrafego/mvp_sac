import { db } from '@/lib/db'
import { leadTags, recoveryLeads } from '@/lib/db/schema'
import { sql } from 'drizzle-orm'

export type InstagramInboundInteraction = 'comment' | 'direct' | 'story_reply' | 'story_reaction'

const TAG_BY_INTERACTION: Record<InstagramInboundInteraction, string> = {
  comment: 'instagram_comentario',
  direct: 'instagram_direct',
  story_reply: 'instagram_resposta_story',
  story_reaction: 'instagram_reacao_story',
}

export function isInstagramStoryReply(message: Record<string, unknown> | undefined): boolean {
  if (!message) return false
  if (message.is_story_reply === true) return true
  const replyTo = message.reply_to
  if (replyTo && typeof replyTo === 'object' && !Array.isArray(replyTo)) {
    const reply = replyTo as Record<string, unknown>
    return Boolean(reply.story || reply.story_id || reply.storyId)
  }
  return false
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
