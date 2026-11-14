import { db } from '@/lib/db'
import { recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { matchesCommentKeywords } from '@/lib/instagram-comment-keywords'
import { evaluateCommentDmPauseBypass } from '@/lib/instagram-comment-pause-bypass'
import { sendInstagramMessage } from '@/lib/instagram'
import { and, eq, sql } from 'drizzle-orm'
import { getBlockingPauseSwitch } from '@/lib/bot-pause'
import { isInstagramStoryReply } from '@/lib/instagram-inbound-tags'
import { STORY_TRIGGER_ENABLED_SLUGS, isStoryTriggerEnabledForSlug } from '@/lib/instagram-story-automation'

export { STORY_TRIGGER_ENABLED_SLUGS }
/** @deprecated use STORY_TRIGGER_ENABLED_SLUGS. */
export const STORY_PROTECTED_SLUGS = STORY_TRIGGER_ENABLED_SLUGS

type StoryMessage = { mid?: unknown; text?: unknown; reply_to?: { story?: { id?: unknown } } }
type StoryRule = { id: number; name: string; keywords: string[] | null; match_type: string; story_id: string | null; dm_message: string; mode: string; enabled_at: Date | string | null }
type QueryResult = { rows?: unknown[] } | unknown[]

function rows<T>(result: QueryResult): T[] { return Array.isArray(result) ? result as T[] : Array.isArray(result?.rows) ? result.rows as T[] : [] }
function dateFrom(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value === 'number') { const d = new Date(value < 10_000_000_000 ? value * 1000 : value); return Number.isNaN(d.getTime()) ? null : d }
  if (typeof value === 'string' && value.trim()) { const n = Number(value); const d = Number.isFinite(n) ? new Date(n < 10_000_000_000 ? n * 1000 : n) : new Date(value); return Number.isNaN(d.getTime()) ? null : d }
  return null
}
function toKeywords(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }
export function isInstagramStoryReplyMessage(message: StoryMessage | null | undefined): message is StoryMessage & { reply_to: { story: { id: string } } } {
  return !!message && typeof message.reply_to?.story?.id === 'string' && message.reply_to.story.id.trim().length > 0
}

function storyIdFrom(message: StoryMessage | null | undefined): string | null {
  return isInstagramStoryReplyMessage(message) ? message.reply_to.story.id.trim() : null
}

function protectedErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string') return 'sem_codigo'
  return error.code.slice(0, 24)
}
async function writeDelivery(input: { companyId: number; automationId?: number | null; senderId: string; storyId: string; messageMid?: string | null; occurredAt: Date; status: string; reason?: string | null; outboundMessageId?: string | null }) {
  await db.execute(sql`INSERT INTO instagram_story_deliveries (company_id, automation_id, sender_id, story_id, message_mid, occurred_at, status, reason, outbound_message_id)
    VALUES (${input.companyId}, ${input.automationId ?? null}, ${input.senderId}, ${input.storyId}, ${input.messageMid ?? null}, ${input.occurredAt}, ${input.status}, ${input.reason ?? null}, ${input.outboundMessageId ?? null})`)
}

/**
 * Consome exclusivamente a resposta a Story da Isabela. O contrato de retorno
 * é deliberadamente fail-closed: uma vez reconhecido o Story protegido, true
 * impede Direct por palavra, follow-check e IA, inclusive se banco/envio falhar.
 */
export async function handleInstagramStoryReplyItem(input: {
  companyId: number; companySlug: string | null | undefined; instagramAccountId?: string | null; senderId: string; message: StoryMessage | null | undefined; itemTimestamp?: string | number | null; lead?: { id?: number | null; botPaused?: boolean | null } | null
}): Promise<boolean> {
  const message = input.message
  if (!isStoryTriggerEnabledForSlug(input.companySlug) || !message || !isInstagramStoryReply(message)) return false
  const storyId = storyIdFrom(message)
  const occurredAt = dateFrom(input.itemTimestamp)
  const messageMid = typeof message.mid === 'string' ? message.mid : null
  try {
    // A Meta pode marcar uma resposta sem fornecer um id utilizável. Ela é
    // consumida para nunca cair na IA, mas não é elegível para automação.
    if (!storyId) {
      await writeDelivery({ companyId: input.companyId, senderId: input.senderId, storyId: 'indisponivel', messageMid, occurredAt: occurredAt ?? new Date(), status: 'skipped', reason: 'Resposta a Story sem identificador utilizável.' })
      return true
    }
    if (!occurredAt) return true
    const activeRules = rows<StoryRule>(await db.execute(sql`SELECT id, name, keywords, match_type, story_id, dm_message, mode, enabled_at
      FROM instagram_story_automations WHERE company_id = ${input.companyId} AND is_active = true ORDER BY (story_id IS NULL), id ASC`))
      .map(rule => ({ ...rule, keywords: toKeywords(rule.keywords) }))
    const text = typeof message.text === 'string' ? message.text : ''
    const rule = activeRules.find(candidate => (candidate.story_id === storyId || candidate.story_id === null) && matchesCommentKeywords(text, candidate.keywords?.join(',') ?? '', candidate.match_type).matched)
    if (!rule) { await writeDelivery({ companyId: input.companyId, senderId: input.senderId, storyId, messageMid, occurredAt, status: 'skipped', reason: 'Nenhuma regra ativa corresponde à resposta.' }); return true }
    const enabledAt = dateFrom(rule.enabled_at)
    if (!enabledAt || occurredAt.getTime() < enabledAt.getTime()) { await writeDelivery({ companyId: input.companyId, automationId: rule.id, senderId: input.senderId, storyId, messageMid, occurredAt, status: 'skipped', reason: 'Resposta anterior à ativação da regra.' }); return true }
    if (Date.now() - occurredAt.getTime() >= 24 * 60 * 60 * 1000 || occurredAt.getTime() > Date.now() + 5 * 60 * 1000) { await writeDelivery({ companyId: input.companyId, automationId: rule.id, senderId: input.senderId, storyId, messageMid, occurredAt, status: 'skipped', reason: 'Fora da janela de 24 horas.' }); return true }

    const [freshLead] = input.lead?.id ? await db.select({ id: recoveryLeads.id, botPaused: recoveryLeads.botPaused, botPausedBy: recoveryLeads.botPausedBy, botPausedAll: recoveryLeads.botPausedAll, botPausedChannel: recoveryLeads.botPausedChannel })
      .from(recoveryLeads).where(and(eq(recoveryLeads.id, input.lead.id), eq(recoveryLeads.companyId, input.companyId))).limit(1) : []
    if (!freshLead) { await writeDelivery({ companyId: input.companyId, automationId: rule.id, senderId: input.senderId, storyId, messageMid, occurredAt, status: 'skipped', reason: 'Lead não encontrado para releitura da pausa.' }); return true }
    const tagResult = rows<{ exists: boolean }>(await db.execute(sql`SELECT EXISTS(SELECT 1 FROM lead_tags WHERE lead_id = ${freshLead.id} AND tag = 'pessoa') AS exists`))
    const switchBlocking = !!await getBlockingPauseSwitch(input.companyId, 'instagram')
    const pause = evaluateCommentDmPauseBypass({ companySlug: input.companySlug, lead: { ...freshLead, hasPessoaTag: tagResult[0]?.exists === true }, switchBlocking, commentCreatedAt: occurredAt })
    if (!pause.bypass) { await writeDelivery({ companyId: input.companyId, automationId: rule.id, senderId: input.senderId, storyId, messageMid, occurredAt, status: 'skipped', reason: `Pausa não contornável: ${pause.reason}.` }); return true }
    if (rule.mode !== 'send') { await writeDelivery({ companyId: input.companyId, automationId: rule.id, senderId: input.senderId, storyId, messageMid, occurredAt, status: 'observed', reason: 'Modo teste: nenhum Direct foi enviado.' }); return true }

    const reservation = rows<{ id: number }>(await db.execute(sql`INSERT INTO instagram_story_deliveries (company_id, automation_id, sender_id, story_id, message_mid, occurred_at, status, reason)
      VALUES (${input.companyId}, ${rule.id}, ${input.senderId}, ${storyId}, ${messageMid}, ${occurredAt}, 'reserved', 'Envio reservado antes do transporte.')
      ON CONFLICT DO NOTHING RETURNING id`))[0]
    if (!reservation) return true
    const result = await sendInstagramMessage({ companyId: input.companyId, recipientId: input.senderId, text: rule.dm_message })
    const status = result.ok && result.messageId ? 'sent' : result.ok || result.uncertain ? 'unknown' : 'failed'
    const reason = status === 'sent' ? null : (result.error || 'A Meta aceitou sem identificador de mensagem; não haverá nova tentativa automática.')
    await db.execute(sql`UPDATE instagram_story_deliveries SET status = ${status}, reason = ${reason}, outbound_message_id = ${result.messageId ?? null} WHERE id = ${reservation.id}`)
    if (status === 'sent' || status === 'unknown') await db.insert(whatsappMessages).values({ companyId: input.companyId, leadId: freshLead.id, phone: `ig_${input.senderId}`, channel: 'instagram', direction: 'outbound', content: rule.dm_message, messageType: 'text', sentBy: 'bot', senderName: 'Automação de Story', externalId: result.messageId ?? null, sendState: status === 'sent' ? 'accepted' : 'uncertain', sendError: reason })
  } catch (error) {
    const name = error instanceof Error ? error.name : 'ErroDesconhecido'
    console.error(`[Instagram Story Trigger] falha protegida name=${name} code=${protectedErrorCode(error)}`)
  }
  return true
}
