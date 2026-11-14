import { db } from '@/lib/db'
import { recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { matchesCommentKeywords } from '@/lib/instagram-comment-keywords'
import { evaluateCommentDmPauseBypass } from '@/lib/instagram-comment-pause-bypass'
import { sendInstagramMessage } from '@/lib/instagram'
import { and, eq, sql } from 'drizzle-orm'
import { getBlockingPauseSwitch, isBotBlocked } from '@/lib/bot-pause'
import { isInstagramStoryReply } from '@/lib/instagram-inbound-tags'
import { STORY_PROTECTED_SLUGS, isStoryProtectedForSlug } from '@/lib/instagram-story-automation'

export { STORY_PROTECTED_SLUGS }

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

async function writeDeliverySafely(input: Parameters<typeof writeDelivery>[0]) {
  try { await writeDelivery(input) } catch { /* O histórico não pode mudar a rota do atendimento. */ }
}

/**
 * A Isabela é protegida de forma fail-closed. Nas demais empresas, a resposta
 * só é consumida quando uma regra em modo envio conseguiu reservar o Direct.
 */
export async function handleInstagramStoryReplyItem(input: {
  companyId: number; companySlug: string | null | undefined; instagramAccountId?: string | null; senderId: string; message: StoryMessage | null | undefined; itemTimestamp?: string | number | null; lead?: { id?: number | null; botPaused?: boolean | null } | null
}): Promise<boolean> {
  const message = input.message
  if (!message || !isInstagramStoryReply(message)) return false
  const protectedCompany = isStoryProtectedForSlug(input.companySlug)
  let directReserved = false
  const fallback = () => protectedCompany || directReserved
  const storyId = storyIdFrom(message)
  const occurredAt = dateFrom(input.itemTimestamp)
  const messageMid = typeof message.mid === 'string' ? message.mid : null
  try {
    if (!storyId) {
      await writeDeliverySafely({ companyId: input.companyId, senderId: input.senderId, storyId: 'indisponivel', messageMid, occurredAt: occurredAt ?? new Date(), status: 'skipped', reason: 'Resposta a Story sem identificador utilizável.' })
      return fallback()
    }
    if (!occurredAt) {
      await writeDeliverySafely({ companyId: input.companyId, senderId: input.senderId, storyId, messageMid, occurredAt: new Date(), status: 'skipped', reason: 'Resposta a Story sem data utilizável.' })
      return fallback()
    }
    const activeRules = rows<StoryRule>(await db.execute(sql`SELECT id, name, keywords, match_type, story_id, dm_message, mode, enabled_at
      FROM instagram_story_automations WHERE company_id = ${input.companyId} AND is_active = true ORDER BY (story_id IS NULL), id ASC`))
      .map(rule => ({ ...rule, keywords: toKeywords(rule.keywords) }))
    const text = typeof message.text === 'string' ? message.text : ''
    const rule = activeRules.find(candidate => (candidate.story_id === storyId || candidate.story_id === null) && matchesCommentKeywords(text, candidate.keywords?.join(',') ?? '', candidate.match_type).matched)
    if (!rule) { await writeDeliverySafely({ companyId: input.companyId, senderId: input.senderId, storyId, messageMid, occurredAt, status: 'skipped', reason: 'Nenhuma regra ativa corresponde à resposta.' }); return fallback() }
    const enabledAt = dateFrom(rule.enabled_at)
    if (!enabledAt || occurredAt.getTime() < enabledAt.getTime()) { await writeDeliverySafely({ companyId: input.companyId, automationId: rule.id, senderId: input.senderId, storyId, messageMid, occurredAt, status: 'skipped', reason: 'Resposta anterior à ativação da regra.' }); return fallback() }
    if (Date.now() - occurredAt.getTime() >= 24 * 60 * 60 * 1000 || occurredAt.getTime() > Date.now() + 5 * 60 * 1000) { await writeDeliverySafely({ companyId: input.companyId, automationId: rule.id, senderId: input.senderId, storyId, messageMid, occurredAt, status: 'skipped', reason: 'Fora da janela de 24 horas.' }); return fallback() }

    const [freshLead] = input.lead?.id ? await db.select({ id: recoveryLeads.id, botPaused: recoveryLeads.botPaused, botPausedBy: recoveryLeads.botPausedBy, botPausedAll: recoveryLeads.botPausedAll, botPausedChannel: recoveryLeads.botPausedChannel })
      .from(recoveryLeads).where(and(eq(recoveryLeads.id, input.lead.id), eq(recoveryLeads.companyId, input.companyId))).limit(1) : []
    if (!freshLead) { await writeDeliverySafely({ companyId: input.companyId, automationId: rule.id, senderId: input.senderId, storyId, messageMid, occurredAt, status: 'skipped', reason: 'Lead não encontrado para releitura da pausa.' }); return fallback() }
    const tagResult = rows<{ exists: boolean }>(await db.execute(sql`SELECT EXISTS(SELECT 1 FROM lead_tags WHERE lead_id = ${freshLead.id} AND tag = 'pessoa') AS exists`))
    const hasPessoaTag = tagResult[0]?.exists === true
    // Empresas comuns obedecem exatamente ao guard normal do bot. O bypass é
    // exclusivo da Isabela; a tag pessoa é uma defesa explícita de anti-loop.
    const pauseDecision = await isBotBlocked({ companyId: input.companyId, channel: 'instagram', leadBotPaused: freshLead.botPaused })
    let pauseBlocked = pauseDecision.blocked || hasPessoaTag
    let pauseReason: string | null = hasPessoaTag ? 'pausa_individual_do_lead' : (pauseDecision.reason ?? 'pausa_ativa')
    if (protectedCompany) {
      const switchBlocking = !!await getBlockingPauseSwitch(input.companyId, 'instagram')
      const pause = evaluateCommentDmPauseBypass({ companySlug: input.companySlug, lead: { ...freshLead, hasPessoaTag }, switchBlocking, commentCreatedAt: occurredAt })
      pauseBlocked = !pause.bypass
      pauseReason = pause.bypass ? null : pause.reason
    }
    if (pauseBlocked) { await writeDeliverySafely({ companyId: input.companyId, automationId: rule.id, senderId: input.senderId, storyId, messageMid, occurredAt, status: 'skipped', reason: `Pausa não contornável: ${pauseReason}.` }); return fallback() }
    if (rule.mode !== 'send') { await writeDeliverySafely({ companyId: input.companyId, automationId: rule.id, senderId: input.senderId, storyId, messageMid, occurredAt, status: 'observed', reason: 'Modo teste: nenhum Direct foi enviado.' }); return fallback() }

    const reservation = rows<{ id: number }>(await db.execute(sql`INSERT INTO instagram_story_deliveries (company_id, automation_id, sender_id, story_id, message_mid, occurred_at, status, reason)
      VALUES (${input.companyId}, ${rule.id}, ${input.senderId}, ${storyId}, ${messageMid}, ${occurredAt}, 'reserved', 'Envio reservado antes do transporte.')
      ON CONFLICT DO NOTHING RETURNING id`))[0]
    if (!reservation) {
      const existing = rows<{ message_mid: string | null; status: string }>(await db.execute(sql`SELECT message_mid, status FROM instagram_story_deliveries
        WHERE company_id = ${input.companyId} AND sender_id = ${input.senderId} AND story_id = ${storyId}
          AND status IN ('reserved', 'sent', 'failed', 'unknown')
        ORDER BY id DESC LIMIT 1`))[0]
      // Uma entrega incerta continua consumida para nunca arriscar reenvio.
      // Fora isso, só uma reentrega identificável da mesma mensagem é
      // consumida; uma nova resposta volta ao fluxo normal da empresa.
      return protectedCompany || existing?.status === 'unknown' || (!!messageMid && existing?.message_mid === messageMid)
    }
    directReserved = true
    const result = await sendInstagramMessage({ companyId: input.companyId, recipientId: input.senderId, text: rule.dm_message })
    const status = result.ok && result.messageId ? 'sent' : result.ok || result.uncertain ? 'unknown' : 'failed'
    const reason = status === 'sent' ? null : (result.error || 'A Meta aceitou sem identificador de mensagem; não haverá nova tentativa automática.')
    await db.execute(sql`UPDATE instagram_story_deliveries SET status = ${status}, reason = ${reason}, outbound_message_id = ${result.messageId ?? null} WHERE id = ${reservation.id}`)
    if (status === 'sent' || status === 'unknown') await db.insert(whatsappMessages).values({ companyId: input.companyId, leadId: freshLead.id, phone: `ig_${input.senderId}`, channel: 'instagram', direction: 'outbound', content: rule.dm_message, messageType: 'text', sentBy: 'bot', senderName: 'Automação de Story', externalId: result.messageId ?? null, sendState: status === 'sent' ? 'accepted' : 'uncertain', sendError: reason })
    if (status === 'failed') return protectedCompany
  } catch (error) {
    const name = error instanceof Error ? error.name : 'ErroDesconhecido'
    console.error(`[Instagram Story Trigger] falha protegida name=${name} code=${protectedErrorCode(error)}`)
  }
  return fallback()
}
