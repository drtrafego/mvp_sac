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
  constructor(operation: 'mensagem' | 'regras de tags', cause: unknown) {
    super(`Não foi possível persistir a ${operation} do inbound do Instagram: ${safePersistenceError(cause)}`)
    this.name = 'InstagramInboundPersistenceError'
    this.cause = cause
  }
}

export type InstagramInboundTagFailure = {
  error: string
}

function safePersistenceError(error: unknown): string {
  const name = error instanceof Error && error.name ? error.name : 'UnknownError'
  const message = error instanceof Error ? error.message : String(error)
  return `${name}: ${message}`
    .replace(/(postgres(?:ql)?:\/\/)[^\s]+/gi, '$1[redacted]')
    .replace(/\b(password|token|secret|authorization|cookie|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 500)
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
}): Promise<{
  inserted: boolean
  matched: string[]
  applied: string[]
  tagFailures: InstagramInboundTagFailure[]
}> {
  if (message.companyId !== companyId || message.leadId !== leadId) {
    throw new InstagramInboundPersistenceError('mensagem', new Error('contexto de empresa ou lead inconsistente'))
  }

  // The message is the idempotency boundary. It must commit independently of
  // optional tag automation so a tag/database failure cannot prevent the AI
  // reply from being scheduled. The unique inbound external_id index handles
  // Meta re-delivery and concurrent webhook requests.
  let inserted = false
  try {
    const [row] = await db.insert(whatsappMessages).values(message).onConflictDoNothing().returning({ id: whatsappMessages.id })
    inserted = Boolean(row?.id)
  } catch (error) {
    throw new InstagramInboundPersistenceError('mensagem', error)
  }

  let matched: Array<{ tag: string; trigger: InstagramInboundTagTrigger }> = []
  const tagFailures: InstagramInboundTagFailure[] = []
  try {
    matched = await findInstagramInboundTags({ companyId, text, isStoryReply, executor: db })
  } catch (error) {
    tagFailures.push({ error: `consulta de regras: ${safePersistenceError(error)}` })
    console.error('[Instagram Inbound] falha ao consultar regras de tags', {
      companyId,
      leadId,
      error: tagFailures[0].error,
    })
  }

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

  const applied: string[] = []
  for (const value of tagValues) {
    try {
      const [row] = await db.insert(leadTags).values(value).onConflictDoNothing().returning({ id: leadTags.id })
      if (row?.id) applied.push(value.tag)
    } catch (error) {
      const safeError = safePersistenceError(error)
      tagFailures.push({ error: safeError })
      console.error('[Instagram Inbound] falha ao persistir tag', {
        companyId,
        leadId,
        error: safeError,
      })
    }
  }

  return { inserted, matched: matched.map(({ tag }) => tag), applied, tagFailures }
}
