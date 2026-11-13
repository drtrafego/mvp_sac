import { db } from '@/lib/db'
import {
  companies,
  instagramCommentAutomations,
  instagramCommentLogs,
  sacAuditEvents,
  recoveryLeads,
  settings,
  whatsappMessages,
  leadTags,
} from '@/lib/db/schema'
import {
  sendInstagramPrivateReply,
  sendInstagramMessage,
  replyInstagramCommentPublic,
  hideInstagramComment,
  checkInstagramUserFollowsBusiness,
  getInstagramCommentCreatedAt,
} from '@/lib/instagram'
import { generateAndSendAiReply } from '@/lib/ai-reply'
import { getBlockingPauseSwitch, getInheritedPauseFields, isBotBlocked } from '@/lib/bot-pause'
import {
  COMMENT_DM_PAUSE_BYPASS_COMPANY_SLUGS,
  evaluateCommentDmPauseBypass,
} from '@/lib/instagram-comment-pause-bypass'
import { eq, and, gte, sql } from 'drizzle-orm'
import { matchesCommentKeywords } from '@/lib/instagram-comment-keywords'
import { normalizeTag, PESSOA_TAG } from '@/lib/lead-tags'
import { isUniqueViolation } from '@/lib/webhook-dedup'
import {
  INSTAGRAM_COMMENT_DM_TEMPLATE_ID,
  INSTAGRAM_COMMENT_DM_TEMPLATE_KEYWORD,
  INSTAGRAM_COMMENT_DM_TEMPLATE_URL,
  renderInstagramCommentDmTemplate,
} from '@/lib/instagram-comment-dm-template'

export interface CommentEventData {
  companyId: number
  commentId: string
  commenterId: string
  commenterUsername?: string
  mediaId: string
  commentText: string
  source?: 'instagram_webhook' | 'unknown'
  commentCreatedAt?: Date | string | number
}

export interface DirectKeywordEventData {
  companyId: number
  messageId: string
  senderId: string
  text: string
  messageCreatedAt?: Date | string | number
  isStoryReply?: boolean
}

async function auditPreparedTemplate(
  companyId: number,
  type: string,
  referenceId: string,
  payload: Record<string, unknown>,
) {
  try {
    await db.insert(sacAuditEvents).values({
      companyId,
      actorType: 'system',
      actorId: 'instagram-comment-automation',
      type,
      referenceType: 'instagram_comment_dm_template',
      referenceId,
      payload,
    })
  } catch (error) {
    console.error('[Comment-to-DM Audit Error]:', error)
  }
}

function parseCommentCreatedAt(value: Date | string | number | undefined): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') {
    const date = new Date(value < 10_000_000_000 ? value * 1000 : value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return null
}

function isWithinMetaPrivateReplyWindow(createdAt: Date, windowHours: number): boolean {
  const ageMs = Date.now() - createdAt.getTime()
  return ageMs >= 0 && ageMs <= windowHours * 60 * 60 * 1000
}

/**
 * Verifica se a hora atual (Horário de Brasília) está dentro da janela configurada
 */
function isWithinActiveHours(startTime?: string | null, endTime?: string | null): boolean {
  if (!startTime || !endTime) return true

  try {
    const now = new Date()
    // Horário de Brasília (UTC-3)
    const formatter = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    const currentTimeStr = formatter.format(now) // "HH:MM"

    if (startTime <= endTime) {
      return currentTimeStr >= startTime && currentTimeStr <= endTime
    } else {
      // Janela que cruza meia-noite (ex: 22:00 até 06:00)
      return currentTimeStr >= startTime || currentTimeStr <= endTime
    }
  } catch (err) {
    console.error('[Comment Processor] Erro ao validar horário:', err)
    return true
  }
}

/**
 * Verifica se o comentário corresponde às palavras-chave da regra
 */
/**
 * Textos do gate de seguidor (24/09/2026). Não são configuráveis por
 * automação de propósito (o pedido foi só o flag liga/desliga, ver
 * comentário em schema.ts): manter fixo evita mais um campo de texto pra
 * validar/testar sem necessidade real hoje.
 */
function buildFollowCheckDenied(username?: string | null): string {
  const handle = username ? `@${username}` : 'a nossa conta'
  return `Ainda não te encontrei seguindo ${handle}. Segue lá e me responde de novo (um "pronto" já serve) que eu libero o conteúdo certinho pra você!`
}

async function auditFollowCheck(
  companyId: number,
  commentId: string,
  payload: Record<string, unknown>,
) {
  try {
    await db.insert(sacAuditEvents).values({
      companyId,
      actorType: 'system',
      actorId: 'instagram-follow-check',
      type: 'instagram_comment_follow_check',
      referenceType: 'instagram_comment',
      referenceId: commentId,
      payload,
    })
  } catch (error) {
    console.error('[Instagram Follow Check Audit Error]:', error)
  }
}

type CommentPauseDecision = Awaited<ReturnType<typeof isBotBlocked>> & { bypassed?: boolean }

/**
 * Decisão de pausa do disparo "comentário vira DM". Igual a isBotBlocked, com
 * UMA exceção (ordem do Gastão, 12/11/2026): na empresa da lista de
 * instagram-comment-pause-bypass.ts, a pausa gerada pela chave da empresa
 * ("Pausar tudo"/"Pausar canal", inclusive a herdada pelo lead) não barra a DM
 * da regra, só para comentário posterior ao corte. Pausa individual do lead
 * (humano, opt-out, tag pessoa, anti-loop) e qualquer outra empresa seguem
 * bloqueando. Lança em erro de banco: quem chama decide (fail-closed).
 */
async function resolveCommentPauseDecision(
  companyId: number,
  commenterId: string,
  resolveCommentCreatedAt: () => Promise<Date | null>,
): Promise<CommentPauseDecision> {
  const [commenterLead] = await db
    .select({
      id: recoveryLeads.id,
      botPaused: recoveryLeads.botPaused,
      botPausedBy: recoveryLeads.botPausedBy,
      botPausedAll: recoveryLeads.botPausedAll,
      botPausedChannel: recoveryLeads.botPausedChannel,
    })
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.companyId, companyId), eq(recoveryLeads.phone, `ig_${commenterId}`)))
    .limit(1)
  const decision = await isBotBlocked({
    companyId,
    channel: 'instagram',
    leadBotPaused: commenterLead?.botPaused ?? false,
  })
  if (!decision.blocked) return decision

  const [company] = await db
    .select({ slug: companies.slug })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1)
  if (!company || !COMMENT_DM_PAUSE_BYPASS_COMPANY_SLUGS.includes(company.slug)) return decision

  const blockingSwitch = await getBlockingPauseSwitch(companyId, 'instagram')
  // Tag "pessoa" (qualquer escopo) = humano assumiu, mesmo que a origem gravada
  // da pausa seja a da chave (a tag não sobrescreve lead já pausado).
  let hasPessoaTag = false
  if (commenterLead?.id) {
    const [pessoaTag] = await db
      .select({ id: leadTags.id })
      .from(leadTags)
      .where(and(eq(leadTags.leadId, commenterLead.id), eq(leadTags.tag, PESSOA_TAG)))
      .limit(1)
    hasPessoaTag = Boolean(pessoaTag)
  }
  const bypass = evaluateCommentDmPauseBypass({
    companySlug: company.slug,
    lead: commenterLead ? { ...commenterLead, hasPessoaTag } : null,
    switchBlocking: blockingSwitch !== null,
    commentCreatedAt: await resolveCommentCreatedAt(),
  })
  if (!bypass.bypass) {
    console.warn(`[Comment-to-DM Pause] Empresa ${companyId}: bypass negado (${bypass.reason}); pausa mantida.`)
    return decision
  }
  return { blocked: false, reason: null, bypassed: true }
}

async function auditCommentPauseBypass(companyId: number, commentId: string, payload: Record<string, unknown>) {
  try {
    await db.insert(sacAuditEvents).values({
      companyId,
      actorType: 'system',
      actorId: 'instagram-comment-automation',
      type: 'instagram_comment_dm_pause_bypass',
      referenceType: 'instagram_comment',
      referenceId: commentId,
      payload,
    })
  } catch (error) {
    console.error('[Comment-to-DM Pause Bypass Audit Error]:', error)
  }
}

async function auditDirectPauseBypass(companyId: number, messageId: string, payload: Record<string, unknown>) {
  try {
    await db.insert(sacAuditEvents).values({
      companyId,
      actorType: 'system',
      actorId: 'instagram-direct-keyword-automation',
      type: 'instagram_direct_keyword_pause_bypass',
      referenceType: 'instagram_direct_message',
      referenceId: messageId,
      payload,
    })
  } catch (error) {
    console.error('[Instagram Direct Keyword Pause Bypass Audit Error]:', error)
  }
}

/**
 * Reaproveita o log 'ignorado_pausa' (e só ele) de (automação, pessoa, mídia)
 * como claim do comentário novo. Só para a empresa da lista do bypass; as
 * demais mantêm onConflictDoNothing. UPDATE condicionado ao status = atômico.
 * Violação do índice por comment_id (corrida) vira "já reivindicado".
 */
async function reuseIgnoredPauseClaim(input: {
  companyId: number
  automationId: number
  commentId: string
  commenterId: string
  commenterUsername?: string
  mediaId: string
  commentText: string
  matchedKeyword?: string
  dedupeScope?: 'both'
}): Promise<{ id: number } | null> {
  const [company] = await db
    .select({ slug: companies.slug })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1)
  if (!company || !COMMENT_DM_PAUSE_BYPASS_COMPANY_SLUGS.includes(company.slug)) return null
  try {
    const [row] = await db
      .update(instagramCommentLogs)
      .set({
        commentId: input.commentId,
        commenterUsername: input.commenterUsername,
        mediaId: input.mediaId,
        commentText: input.commentText,
        matchedKeyword: input.matchedKeyword,
        dedupeScope: input.dedupeScope ?? null,
        status: 'processing',
        errorMessage: null,
        sentAt: null,
        createdAt: new Date(),
      })
      .where(and(
        eq(instagramCommentLogs.companyId, input.companyId),
        eq(instagramCommentLogs.automationId, input.automationId),
        eq(instagramCommentLogs.commenterId, input.commenterId),
        ...(input.dedupeScope === 'both'
          ? [eq(instagramCommentLogs.dedupeScope, 'both')]
          : [eq(instagramCommentLogs.mediaId, input.mediaId)]),
        eq(instagramCommentLogs.status, 'ignorado_pausa'),
      ))
      .returning({ id: instagramCommentLogs.id })
    return row ?? null
  } catch (err) {
    if (isUniqueViolation(err)) return null
    throw err
  }
}

/**
 * Processador central de comentários do Instagram para acionamento de DM automática
 */
export async function processInstagramComment(event: CommentEventData) {
  const { companyId, commentId, commenterId, commenterUsername, mediaId, commentText } = event

  if (!commentId || !commenterId || !companyId) {
    return { status: 'skipped', reason: 'dados_incompletos' }
  }

  // 1. Idempotência por commentId (Meta pode reenviar o mesmo webhook)
  const [existingComment] = await db
    .select({ id: instagramCommentLogs.id })
    .from(instagramCommentLogs)
    .where(
      and(
        eq(instagramCommentLogs.companyId, companyId),
        eq(instagramCommentLogs.commentId, commentId)
      )
    )
    .limit(1)

  if (existingComment) {
    return { status: 'skipped', reason: 'comment_already_processed' }
  }

  // 2. Verificação de Rate Limit (Máximo 750 DMs por hora pela Meta Graph API)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(instagramCommentLogs)
    .where(
      and(
        eq(instagramCommentLogs.companyId, companyId),
        eq(instagramCommentLogs.status, 'sent'),
        gte(instagramCommentLogs.sentAt, oneHourAgo)
      )
    )

  if (count >= 750) {
    console.warn(`[Comment-to-DM Rate Limit Exceeded] Empresa ${companyId}: ${count} DMs na última hora`)
    await db.insert(instagramCommentLogs).values({
      companyId,
      commentId,
      commenterId,
      commenterUsername,
      mediaId,
      commentText,
      status: 'rate_limited',
      errorMessage: 'Limite de 750 DMs/hora atingido para a conta.',
    }).onConflictDoNothing()
    return { status: 'rate_limited' }
  }

  // 3. Busca regras ativas da empresa
  const automations = await db
    .select()
    .from(instagramCommentAutomations)
    .where(
      and(
        eq(instagramCommentAutomations.companyId, companyId),
        eq(instagramCommentAutomations.isActive, true)
      )
    )

  if (automations.length === 0) {
    return { status: 'skipped', reason: 'no_active_automations' }
  }

  // Filtra regras que se aplicam a este post (ou a qualquer post se mediaId for null/vazio)
  let applicableAutomations = automations.filter(rule => {
    if (rule.triggerType !== 'comment' && rule.triggerType !== 'both') return false
    if (!rule.mediaId) return true // regra global para todos os posts
    return rule.mediaId === mediaId
  })
  applicableAutomations.sort((left, right) => {
    const leftIsGlobal = !left.mediaId
    const rightIsGlobal = !right.mediaId
    if (leftIsGlobal !== rightIsGlobal) return leftIsGlobal ? 1 : -1
    return left.id - right.id
  })

  if (applicableAutomations.length === 0) {
    return { status: 'skipped', reason: 'no_matching_post_rule' }
  }

  // Luana é um gatilho reservado ao template 021126. Regras legadas com a
  // mesma palavra podem ter DM ou resposta pública diferentes e não podem
  // assumir esse fluxo enquanto a configuração aprovada não estiver presente.
  const isLuanaTrigger = matchesCommentKeywords(
    commentText,
    INSTAGRAM_COMMENT_DM_TEMPLATE_KEYWORD,
    'contains',
  ).matched
  if (isLuanaTrigger) {
    const preparedRules = applicableAutomations.filter(rule => rule.templateId === INSTAGRAM_COMMENT_DM_TEMPLATE_ID)
    if (preparedRules.length === 0) {
      await auditPreparedTemplate(companyId, 'instagram_comment_dm_blocked', commentId, {
        templateId: INSTAGRAM_COMMENT_DM_TEMPLATE_ID,
        reason: 'gatilho_luana_sem_template_021126_configurado',
        keyword: INSTAGRAM_COMMENT_DM_TEMPLATE_KEYWORD,
      })
      return { status: 'blocked', reason: 'luana_template_not_configured' }
    }
    applicableAutomations = preparedRules
  }

  // 4. Encontra a primeira regra que casa com o horário e as palavras-chave
  let matchedRule: typeof automations[0] | null = null
  let matchedKeywordFound: string | undefined

  for (const rule of applicableAutomations) {
    // Checa janela de horários
    if (!isWithinActiveHours(rule.activeHoursStart, rule.activeHoursEnd)) {
      continue
    }

    const { matched, matchedKeyword } = matchesCommentKeywords(commentText, rule.keywords, rule.matchType)
    if (matched) {
      matchedRule = rule
      matchedKeywordFound = matchedKeyword
      break
    }
  }

  if (!matchedRule) {
    return { status: 'skipped', reason: 'no_keyword_matched' }
  }
  const dedupeScope = matchedRule.triggerType === 'both' ? 'both' as const : undefined

  // Trava de pausa: ANTES de qualquer chamada à Graph API (follow check, janela
  // da Meta) e antes de reivindicar o comentário. Vale a chave da empresa para
  // o canal Instagram (leads existentes E futuros) e o lead.botPaused de quem
  // comentou. Pausado = não envia DM nem resposta pública nem oculta o
  // comentário; só registra o log da regra como 'ignorado_pausa'. Erro ao ler
  // a pausa também não envia (fail-closed): um envio automático nunca sai no escuro.
  // Timestamp do comentário, lido sob demanda (só o bypass precisa) e uma vez só.
  let commentCreatedAtCache: Date | null | undefined
  const resolveCommentCreatedAt = async (): Promise<Date | null> => {
    if (commentCreatedAtCache !== undefined) return commentCreatedAtCache
    let createdAt = parseCommentCreatedAt(event.commentCreatedAt)
    if (!createdAt) {
      const timestamp = await getInstagramCommentCreatedAt({ commentId, companyId })
      if (timestamp.ok) createdAt = timestamp.createdAt ?? null
    }
    commentCreatedAtCache = createdAt
    return createdAt
  }

  let pauseDecision: CommentPauseDecision
  try {
    pauseDecision = await resolveCommentPauseDecision(companyId, commenterId, resolveCommentCreatedAt)
  } catch (err) {
    console.error(`[Comment-to-DM Pause Check Error] Empresa ${companyId}, comment ${commentId}:`, err)
    return { status: 'blocked', reason: 'pause_check_failed', matched: true }
  }
  if (pauseDecision.blocked) {
    await db.insert(instagramCommentLogs).values({
      companyId,
      automationId: matchedRule.id,
      commentId,
      commenterId,
      commenterUsername,
      mediaId,
      commentText,
      matchedKeyword: matchedKeywordFound,
      dedupeScope,
      status: 'ignorado_pausa',
      errorMessage: pauseDecision.reason === 'switch'
        ? `Bot pausado na empresa (chave ${pauseDecision.scope}). Nenhuma mensagem enviada.`
        : 'Bot pausado para este lead. Nenhuma mensagem enviada.',
    }).onConflictDoNothing()
    return { status: 'ignored', reason: 'ignorado_pausa', matched: true }
  }

  const isPreparedTemplate = matchedRule.templateId === INSTAGRAM_COMMENT_DM_TEMPLATE_ID
  if (isPreparedTemplate) {
    const invalidRegistration =
      event.source !== 'instagram_webhook' ||
      !matchedRule.consentRequired ||
      matchedRule.apiOrigin !== 'instagram_graph' ||
      matchedRule.publicReply !== null ||
      matchedRule.hideCommentAfterReply ||
      matchedRule.dmMessage !== renderInstagramCommentDmTemplate({ url: INSTAGRAM_COMMENT_DM_TEMPLATE_URL }) ||
      matchedRule.templateVariables?.url !== INSTAGRAM_COMMENT_DM_TEMPLATE_URL

    if (invalidRegistration) {
      await auditPreparedTemplate(companyId, 'instagram_comment_dm_blocked', commentId, {
        templateId: INSTAGRAM_COMMENT_DM_TEMPLATE_ID,
        reason: 'registro_invalido_ou_evento_sem_consentimento_oficial',
        apiOrigin: matchedRule.apiOrigin,
      })
      return { status: 'blocked', reason: 'template_registration_or_consent_invalid' }
    }

    let createdAt = parseCommentCreatedAt(event.commentCreatedAt)
    if (!createdAt) {
      const timestamp = await getInstagramCommentCreatedAt({ commentId, companyId })
      if (timestamp.ok) createdAt = timestamp.createdAt ?? null
    }
    if (!createdAt || !isWithinMetaPrivateReplyWindow(createdAt, matchedRule.metaWindowHours || 168)) {
      await auditPreparedTemplate(companyId, 'instagram_comment_dm_blocked', commentId, {
        templateId: INSTAGRAM_COMMENT_DM_TEMPLATE_ID,
        reason: 'fora_da_janela_meta_ou_timestamp_indisponivel',
        windowHours: matchedRule.metaWindowHours || 168,
      })
      return { status: 'blocked', reason: 'meta_private_reply_window' }
    }
  }

  // O comentário já é a interação oficial recebida pelo Instagram. Consulta
  // a própria Instagram User Profile API imediatamente; nunca transforma a
  // verificação em uma pergunta de confirmação para o cliente.
  let followCheckFollows: boolean | null = null
  if (matchedRule.requireFollowCheck) {
    const followCheck = await checkInstagramUserFollowsBusiness({
      igsid: commenterId,
      companyId,
    })

    if (!followCheck.ok) {
      await auditFollowCheck(companyId, commentId, {
        decision: 'blocked',
        reason: 'instagram_follow_api_error',
        apiOrigin: 'instagram_graph',
        error: followCheck.error ?? 'erro_sem_detalhe',
      })
      console.error(`[Comment-to-DM Follow Check Error] Empresa ${companyId}, comment ${commentId}:`, followCheck.error)
      return { status: 'blocked', reason: 'follow_check_api_error', error: followCheck.error }
    }

    followCheckFollows = followCheck.follows === true
    await auditFollowCheck(companyId, commentId, {
      decision: followCheckFollows ? 'follows' : 'does_not_follow',
      apiOrigin: 'instagram_graph',
    })
  }

  // 5. Deduplicação por Usuário + Post + Regra. Para "ambos", comentário e
  // Direct são uma só promessa: a pessoa recebe a DM uma vez, independente da
  // ordem ou do post em que usou a palavra.
  if (mediaId) {
    const [alreadySentToUser] = await db
      .select({ id: instagramCommentLogs.id })
      .from(instagramCommentLogs)
      .where(
        and(
          eq(instagramCommentLogs.automationId, matchedRule.id),
          eq(instagramCommentLogs.commenterId, commenterId),
          ...(matchedRule.triggerType === 'both' ? [] : [eq(instagramCommentLogs.mediaId, mediaId)]),
          eq(instagramCommentLogs.status, 'sent')
        )
      )
      .limit(1)

    if (alreadySentToUser) {
      await db.insert(instagramCommentLogs).values({
        companyId,
        automationId: matchedRule.id,
        commentId,
        commenterId,
        commenterUsername,
        mediaId,
        commentText,
        matchedKeyword: matchedKeywordFound,
        status: 'skipped',
        errorMessage: 'Usuário já recebeu DM para este mesmo post.',
      }).onConflictDoNothing()
      return { status: 'skipped', reason: 'already_sent_for_this_media' }
    }
  }

  // A claim is written before the external call. The unique comment index
  // makes concurrent Meta webhook deliveries idempotent and prevents two DMs
  // from leaving the process at the same time.
  let [claim] = await db.insert(instagramCommentLogs).values({
    companyId,
    automationId: matchedRule.id,
    commentId,
    commenterId,
    commenterUsername,
    mediaId,
    commentText,
    matchedKeyword: matchedKeywordFound,
    dedupeScope,
    status: 'processing',
  }).onConflictDoNothing().returning({ id: instagramCommentLogs.id })
  if (!claim) {
    if (dedupeScope) {
      ;[claim] = await db.update(instagramCommentLogs).set({
        commentId, commenterUsername, mediaId, commentText, matchedKeyword: matchedKeywordFound,
        status: 'processing', errorMessage: null, sentAt: null, createdAt: new Date(),
      }).where(and(
        eq(instagramCommentLogs.automationId, matchedRule.id),
        eq(instagramCommentLogs.commenterId, commenterId),
        eq(instagramCommentLogs.dedupeScope, dedupeScope),
        eq(instagramCommentLogs.status, 'failed'),
      )).returning({ id: instagramCommentLogs.id })
    }
  }
  if (!claim) {
    // Índice único (automação, pessoa, mídia): o log 'ignorado_pausa' de um
    // comentário ANTERIOR da mesma pessoa no mesmo post ocupa a vaga e barrava
    // para sempre o comentário novo, mesmo depois do bypass. Só na empresa da
    // lista do bypass e só quando o status existente é 'ignorado_pausa' (nunca
    // enviado/falha/processando) a linha é reaproveitada, com UPDATE atômico
    // condicionado ao status: entregas concorrentes disputam e só uma vence.
    const reused = await reuseIgnoredPauseClaim({
      companyId, automationId: matchedRule.id, commentId, commenterId, commenterUsername, mediaId, commentText,
      matchedKeyword: matchedKeywordFound,
      dedupeScope,
    })
    if (!reused) return { status: 'skipped', reason: 'comment_claim_already_exists' }
    claim = reused
  }

  // 6. Disparo da Resposta Privada (Private Reply) via Graph API.
  // A verificação de seguidor já aconteceu acima, no próprio comentário.
  // Não seguimos a alegação do cliente: o conteúdo final só sai quando a
  // Instagram User Profile API confirmou is_user_follow_business=true.
  let sentText = matchedRule.dmMessage
  const followCheckRequiresAnotherInteraction =
    matchedRule.requireFollowCheck && followCheckFollows === false
  if (followCheckRequiresAnotherInteraction) {
    const [config] = await db
      .select({ instagramUsername: settings.instagramUsername })
      .from(settings)
      .where(eq(settings.companyId, companyId))
      .limit(1)
    sentText = buildFollowCheckDenied(config?.instagramUsername)
  }

  // Segunda leitura da pausa, colada no envio: a Graph API do follow check e
  // as consultas acima levam tempo, e uma pausa ligada nesse intervalo tem que
  // valer. Leitura com erro também não envia.
  let lastPauseDecision: CommentPauseDecision | null = null
  try {
    lastPauseDecision = await resolveCommentPauseDecision(companyId, commenterId, resolveCommentCreatedAt)
  } catch (err) {
    console.error(`[Comment-to-DM Pause Recheck Error] Empresa ${companyId}, comment ${commentId}:`, err)
  }
  if (!lastPauseDecision || lastPauseDecision.blocked) {
    await db.update(instagramCommentLogs).set({
      status: 'ignorado_pausa',
      errorMessage: lastPauseDecision ? 'Bot pausado antes do envio. Nenhuma mensagem enviada.' : 'Não foi possível confirmar a pausa antes do envio. Nenhuma mensagem enviada.',
    }).where(eq(instagramCommentLogs.id, claim.id))
    return { status: 'ignored', reason: 'ignorado_pausa' }
  }

  const dmResult = await sendInstagramPrivateReply({
    commentId,
    text: sentText,
    companyId,
  })

  if (!dmResult.ok) {
    console.error(`[Comment-to-DM Error] Empresa ${companyId}, comment ${commentId}:`, dmResult.error)
    await db.update(instagramCommentLogs).set({ status: 'failed', errorMessage: dmResult.error }).where(eq(instagramCommentLogs.id, claim.id))
    if (isPreparedTemplate) {
      await auditPreparedTemplate(companyId, 'instagram_comment_dm_failed', commentId, {
        templateId: INSTAGRAM_COMMENT_DM_TEMPLATE_ID,
        mediaId,
        error: dmResult.error ?? 'erro_sem_detalhe',
      })
    }
    return { status: 'failed', error: dmResult.error }
  }

  // 7. Sucesso no Envio da DM: grava log e incrementa contador da automação
  const now = new Date()
  await db.update(instagramCommentLogs).set({ status: 'sent', sentAt: now, errorMessage: null }).where(eq(instagramCommentLogs.id, claim.id))

  // Auditoria do bypass só com o envio confirmado (DM que falhou não vira "disparo liberado").
  if (pauseDecision.bypassed || lastPauseDecision.bypassed) {
    await auditCommentPauseBypass(companyId, commentId, {
      automationId: matchedRule.id,
      mediaId,
      reason: 'disparo_comentario_vira_dm_nao_e_bot',
    })
  }

  if (isPreparedTemplate) {
    await auditPreparedTemplate(companyId, 'instagram_comment_dm_sent', commentId, {
      templateId: INSTAGRAM_COMMENT_DM_TEMPLATE_ID,
      mediaId,
      apiOrigin: 'instagram_graph',
      publicReply: false,
    })
  }

  await db
    .update(instagramCommentAutomations)
    .set({
      totalTriggered: sql`${instagramCommentAutomations.totalTriggered} + 1`,
      updatedAt: now,
    })
    .where(eq(instagramCommentAutomations.id, matchedRule.id))

  // 8. Ações Adicionais Opcionais: Resposta pública e Ocultação de comentário
  if (matchedRule.publicReply && matchedRule.publicReply.trim()) {
    replyInstagramCommentPublic({
      commentId,
      mediaId,
      text: matchedRule.publicReply.trim(),
      companyId,
    }).catch(err => console.error('[Comment-to-DM Public Reply Error]:', err))
  }

  if (matchedRule.hideCommentAfterReply) {
    hideInstagramComment({
      commentId,
      companyId,
      hide: true,
    }).catch(err => console.error('[Comment-to-DM Hide Comment Error]:', err))
  }

  // 9. Vinculação e Registro na Linha do Tempo Unificada do SAC (Inbox & Leads)
  try {
    const igPhone = `ig_${commenterId}`
    const displayName = commenterUsername ? `@${commenterUsername}` : `Instagram (${commenterId.slice(-4)})`

    let [lead] = await db
      .select()
      .from(recoveryLeads)
      .where(and(eq(recoveryLeads.companyId, companyId), eq(recoveryLeads.phone, igPhone)))
      .limit(1)

    if (!lead) {
      const inheritedPause = await getInheritedPauseFields(companyId, 'instagram')
      const [newLead] = await db
        .insert(recoveryLeads)
        .values({
          ...inheritedPause,
          companyId,
          platform: 'instagram',
          channel: 'instagram',
          eventType: 'comment_to_dm',
          phone: igPhone,
          name: displayName,
          status: 'in_conversation',
          trackingSource: 'instagram_comment',
          // Lead novo, sem estado anterior pra preservar: grava direto.
          pendingFollowCheckAutomationId: followCheckRequiresAnotherInteraction ? matchedRule.id : null,
          pendingFollowCheckAttempts: 0,
        })
        .returning()
      lead = newLead
    } else {
      const updateSet: Partial<typeof recoveryLeads.$inferInsert> = {
        updatedAt: now,
        // lastActionAt precisa entrar aqui: o COALESCE de ordenação do
        // Inbox trava no primeiro valor não nulo, então a DM enviada pelo
        // comentário automático não subia a conversa quando lastActionAt
        // já existia de antes.
        lastActionAt: now,
        channel: 'instagram',
        name: lead.name && !lead.name.startsWith('Instagram Direct') ? lead.name : displayName,
      }

      // FIX CRÍTICO de QA (24/09/2026, 2ª rodada): só grava o campo do gate
      // quando ESTA automação exige seguir. Antes, qualquer comentário casado
      // (inclusive de automação SEM o flag) sobrescrevia
      // pendingFollowCheckAutomationId pra null incondicionalmente, e
      // derrubava silenciosamente um gate pendente de OUTRA automação: pessoa
      // comenta no post A (com o flag) → fica pendente → comenta no post B
      // (sem o flag) antes de responder → o pendente de A é apagado sem
      // ninguém saber → a resposta dela confirmando A cai direto na IA
      // normal, o conteúdo de A nunca libera mesmo ela seguindo de verdade.
      // Automação sem o flag agora NUNCA toca este campo (nem lê, nem
      // escreve): o gate pendente de outra automação, se existir, continua
      // intacto até ela responder ou até o limite de tentativas (ver
      // handleFollowCheckReply). Automação COM o flag ainda sobrescreve um
      // gate pendente de OUTRA automação com flag (última pergunta vale,
      // decisão de produto já documentada em schema.ts) — isso não mudou.
      if (matchedRule.requireFollowCheck) {
        updateSet.pendingFollowCheckAutomationId = followCheckRequiresAnotherInteraction ? matchedRule.id : null
        updateSet.pendingFollowCheckAttempts = 0
      }

      await db.update(recoveryLeads).set(updateSet).where(eq(recoveryLeads.id, lead.id))
    }

    // A regra já foi casada e a conversa foi materializada no SAC. O índice
    // único de lead_tags torna reentregas da Meta e corridas inofensivas.
    if (matchedRule.autoTag && lead?.id) {
      await db.insert(leadTags).values({
        leadId: lead.id,
        tag: normalizeTag(matchedRule.autoTag),
        scopeChannel: 'instagram',
        createdBy: 'automation:instagram:comment',
      }).onConflictDoNothing()
    }

    // Grava a mensagem enviada (orientação aprovada para não seguidores ou
    // dmMessage aprovado para seguidores) na tabela unificada de mensagens.
    await db.insert(whatsappMessages).values({
      companyId,
      leadId: lead?.id ?? null,
      phone: igPhone,
      channel: 'instagram',
      direction: 'outbound',
      content: sentText,
      messageType: 'text',
      sentBy: 'bot',
      externalId: dmResult.messageId ?? null,
    })
  } catch (err) {
    console.error('[Comment-to-DM Lead/Message Sync Error]:', err)
  }

  return { status: 'sent', messageId: dmResult.messageId }
}

/**
 * Resposta determinística a uma palavra recebida no Direct. Ela usa os mesmos
 * logs e a mesma decisão de pausa do comentário, mas nunca executa IA e nunca
 * trata resposta de Story como Direct comum.
 */
export async function processInstagramDirectKeyword(event: DirectKeywordEventData) {
  const { companyId, messageId, senderId, text } = event
  if (!companyId || !messageId || !senderId || !text.trim() || event.isStoryReply) {
    return { status: 'skipped', reason: 'dados_incompletos_ou_story' }
  }

  const createdAt = parseCommentCreatedAt(event.messageCreatedAt)
  // A Messaging API só pode responder enquanto a conversa está aberta. Não
  // aceitamos timestamp ausente, pois seria possível responder uma DM antiga.
  if (!createdAt || !isWithinMetaPrivateReplyWindow(createdAt, 24)) {
    return { status: 'skipped', reason: 'meta_messaging_window' }
  }

  const automations = await db.select().from(instagramCommentAutomations).where(and(
    eq(instagramCommentAutomations.companyId, companyId),
    eq(instagramCommentAutomations.isActive, true),
  ))
  let matchedRule: typeof automations[number] | null = null
  let matchedKeyword: string | undefined
  for (const rule of automations) {
    if (rule.triggerType !== 'direct' && rule.triggerType !== 'both') continue
    // "Qualquer comentário" não é uma palavra-chave e nunca pode capturar
    // toda a conversa no Direct.
    if (rule.matchType === 'any') continue
    // O follow check só existe para a interação de comentário. Em uma regra
    // "ambos", o Direct deixa a mensagem seguir para o fluxo normal da IA.
    if (rule.requireFollowCheck) continue
    if (!isWithinActiveHours(rule.activeHoursStart, rule.activeHoursEnd)) continue
    const match = matchesCommentKeywords(text, rule.keywords, rule.matchType)
    if (match.matched) {
      matchedRule = rule
      matchedKeyword = match.matchedKeyword
      break
    }
  }
  if (!matchedRule) return { status: 'skipped', reason: 'no_direct_keyword_matched', matched: false }
  const dedupeScope = matchedRule.triggerType === 'both' ? 'both' as const : undefined

  let pauseDecision: CommentPauseDecision
  try {
    pauseDecision = await resolveCommentPauseDecision(companyId, senderId, async () => createdAt)
  } catch (error) {
    console.error(`[Instagram Direct Keyword Pause Check Error] Empresa ${companyId}, mensagem ${messageId}:`, error)
    return { status: 'blocked', reason: 'pause_check_failed', matched: false }
  }
  if (pauseDecision.blocked) {
    await db.insert(instagramCommentLogs).values({
      companyId, automationId: matchedRule.id, commentId: messageId, commenterId: senderId,
      mediaId: null, commentText: text, matchedKeyword, dedupeScope, status: 'ignorado_pausa',
      errorMessage: 'Bot pausado para este lead. Nenhuma mensagem enviada.',
    }).onConflictDoNothing()
    return { status: 'ignored', reason: 'ignorado_pausa', matched: false }
  }

  // Uma DM já confirmada, seja por comentário ou por Direct, encerra a regra
  // "both" para esta pessoa. Não é um match desta chamada, portanto a IA pode
  // responder a uma nova pergunta recebida no Direct.
  const [alreadySent] = await db.select({ id: instagramCommentLogs.id })
    .from(instagramCommentLogs)
    .where(and(
      eq(instagramCommentLogs.automationId, matchedRule.id),
      eq(instagramCommentLogs.commenterId, senderId),
      eq(instagramCommentLogs.status, 'sent'),
    ))
    .limit(1)
  if (alreadySent) return { status: 'skipped', reason: 'direct_rule_already_claimed', matched: false }

  let [claim] = await db.insert(instagramCommentLogs).values({
    companyId, automationId: matchedRule.id, commentId: messageId, commenterId: senderId,
    mediaId: null, commentText: text, matchedKeyword, dedupeScope, status: 'processing',
  }).onConflictDoNothing().returning({ id: instagramCommentLogs.id })
  // Falha de Graph é transitória. A próxima mensagem com a mesma palavra pode
  // tentar novamente, mas somente a linha failed é retomada de forma atômica.
  if (!claim) {
    ;[claim] = await db.update(instagramCommentLogs).set({
      commentId: messageId, commentText: text, matchedKeyword, status: 'processing',
      errorMessage: null, sentAt: null, createdAt: new Date(),
    }).where(and(
      eq(instagramCommentLogs.companyId, companyId),
      eq(instagramCommentLogs.automationId, matchedRule.id),
      eq(instagramCommentLogs.commenterId, senderId),
      ...(dedupeScope
        ? [eq(instagramCommentLogs.dedupeScope, dedupeScope)]
        : [sql`${instagramCommentLogs.mediaId} is null`]),
      eq(instagramCommentLogs.status, 'failed'),
    )).returning({ id: instagramCommentLogs.id })
  }
  // A pausa herdada da chave pode ser removida por um humano. Na allowlist,
  // reaproveitamos somente o log ignorado_pausa, como no comentário.
  if (!claim) {
    const [company] = await db.select({ slug: companies.slug }).from(companies)
      .where(eq(companies.id, companyId)).limit(1)
    if (company && COMMENT_DM_PAUSE_BYPASS_COMPANY_SLUGS.includes(company.slug)) {
      ;[claim] = await db.update(instagramCommentLogs).set({
        commentId: messageId, commentText: text, matchedKeyword, status: 'processing',
        errorMessage: null, sentAt: null, createdAt: new Date(),
      }).where(and(
        eq(instagramCommentLogs.companyId, companyId),
        eq(instagramCommentLogs.automationId, matchedRule.id),
        eq(instagramCommentLogs.commenterId, senderId),
        ...(dedupeScope
          ? [eq(instagramCommentLogs.dedupeScope, dedupeScope)]
          : [sql`${instagramCommentLogs.mediaId} is null`]),
        eq(instagramCommentLogs.status, 'ignorado_pausa'),
      )).returning({ id: instagramCommentLogs.id })
    }
  }
  if (!claim) return { status: 'skipped', reason: 'direct_rule_already_claimed', matched: false }

  let lastPauseDecision: CommentPauseDecision | null = null
  try {
    lastPauseDecision = await resolveCommentPauseDecision(companyId, senderId, async () => createdAt)
  } catch (error) {
    console.error(`[Instagram Direct Keyword Pause Recheck Error] Empresa ${companyId}, mensagem ${messageId}:`, error)
  }
  if (!lastPauseDecision || lastPauseDecision.blocked) {
    await db.update(instagramCommentLogs).set({
      status: 'ignorado_pausa',
      errorMessage: 'Bot pausado antes do envio. Nenhuma mensagem enviada.',
    }).where(eq(instagramCommentLogs.id, claim.id))
    return { status: 'ignored', reason: 'ignorado_pausa', matched: false }
  }

  const result = await sendInstagramMessage({ companyId, recipientId: senderId, text: matchedRule.dmMessage })
  if (!result.ok) {
    await db.update(instagramCommentLogs).set({ status: 'failed', errorMessage: result.error ?? 'Falha ao enviar Direct.' }).where(eq(instagramCommentLogs.id, claim.id))
    return { status: 'failed', error: result.error, matched: true }
  }

  const now = new Date()
  await db.update(instagramCommentLogs).set({ status: 'sent', sentAt: now, errorMessage: null }).where(eq(instagramCommentLogs.id, claim.id))
  await db.update(instagramCommentAutomations).set({
    totalTriggered: sql`${instagramCommentAutomations.totalTriggered} + 1`, updatedAt: now,
  }).where(eq(instagramCommentAutomations.id, matchedRule.id))
  if (pauseDecision.bypassed || lastPauseDecision.bypassed) {
    await auditDirectPauseBypass(companyId, messageId, { automationId: matchedRule.id, reason: 'disparo_direct_por_palavra_nao_e_bot' })
  }
  // O inbound já materializou o lead antes desta função no webhook. Não o
  // reativa: a automação determinística respeita a pausa e só registra a DM.
  try {
    const igPhone = `ig_${senderId}`
    const [lead] = await db.select({ id: recoveryLeads.id }).from(recoveryLeads)
      .where(and(eq(recoveryLeads.companyId, companyId), eq(recoveryLeads.phone, igPhone))).limit(1)
    if (matchedRule.autoTag && lead?.id) {
      await db.insert(leadTags).values({
        leadId: lead.id, tag: normalizeTag(matchedRule.autoTag), scopeChannel: 'instagram',
        createdBy: 'automation:instagram:direct',
      }).onConflictDoNothing()
    }
    await db.insert(whatsappMessages).values({
      companyId, leadId: lead?.id ?? null, phone: igPhone, channel: 'instagram',
      direction: 'outbound', content: matchedRule.dmMessage, messageType: 'text', sentBy: 'bot',
      externalId: result.messageId ?? null,
    })
  } catch (error) {
    console.error(`[Instagram Direct Keyword Inbox Sync Error] Empresa ${companyId}:`, error)
  }
  return { status: 'sent', automationId: matchedRule.id, matched: true }
}

// Limite de respostas sem confirmar seguir, antes do gate desistir (FIX ALTO
// de QA, 24/09/2026, 2ª rodada). Sem isto, uma pessoa que decidiu não seguir
// mas quer falar de outra coisa (emoji, pergunta sobre outro assunto, "não
// quero seguir") ficava sequestrada pra sempre recebendo "segue lá que
// libero", sem endpoint nem atalho de UI pra um atendente zerar isso na mão.
// Fix mínimo aceitável: depois deste tanto de tentativas, o gate desiste
// sozinho e devolve a conversa pro fluxo normal de IA (ver mais abaixo).
const MAX_FOLLOW_CHECK_ATTEMPTS = 3

// db.execute(sql`...`) devolve FORMATOS DIFERENTES por driver: neon-http
// (produção, @neondatabase/serverless) devolve um objeto com `.rows`;
// postgres-js (usado nos testes contra Postgres descartável real) devolve a
// lista de linhas direto, sem essa propriedade. Sem isto, a checagem "a
// claim foi minha" abaixo quebraria silenciosamente só no ambiente de teste
// (result.rows undefined ali, mas funcionando por acaso em produção).
function unwrapExecRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows
  }
  return []
}

/**
 * Releitura da pausa COLADA no envio do gate de seguidor. A checagem da entrada
 * de handleFollowCheckReply vale antes da Graph API, mas a pausa pode ligar
 * enquanto ela responde. true = NÃO enviar (pausa ligada ou leitura falhou:
 * fail-closed, nenhuma mensagem sai no escuro).
 */
async function followCheckSendBlocked(companyId: number, leadId: number, where: string): Promise<boolean> {
  try {
    const [pausedLead] = await db
      .select({ botPaused: recoveryLeads.botPaused })
      .from(recoveryLeads)
      .where(eq(recoveryLeads.id, leadId))
      .limit(1)
    const decision = await isBotBlocked({ companyId, channel: 'instagram', leadBotPaused: pausedLead?.botPaused ?? false })
    if (decision.blocked) {
      console.warn(`[Follow Check] Empresa ${companyId}, lead ${leadId}: ignorado_pausa antes do envio (${where}); nada enviado.`)
      return true
    }
    return false
  } catch (err) {
    console.error(`[Follow Check] Empresa ${companyId}, lead ${leadId}: falha ao reler a pausa antes do envio (${where}); nada enviado:`, err)
    return true
  }
}

/**
 * Segunda etapa do gate de seguidor (24/09/2026): chamado pelo webhook
 * inbound do Instagram (route.ts e [slug]/route.ts) quando o lead que
 * respondeu tem `pendingFollowCheckAutomationId` setado (e o bot não está
 * pausado por um humano, ver comentário nos webhooks), em vez de cair no
 * generateAndSendAiReply normal. Confere de verdade via Graph API
 * (is_user_follow_business) e decide:
 *   - segue: libera o dmMessage real da automação e limpa o estado pendente.
 *     Usa claim-then-act (ver FIX CRÍTICO abaixo) pra nunca liberar duas
 *     vezes com respostas concorrentes da mesma pessoa.
 *   - não segue: reforça o pedido pra seguir e MANTÉM o estado pendente, pra
 *     checar de novo na próxima resposta dela — até bater
 *     MAX_FOLLOW_CHECK_ATTEMPTS, quando desiste (ver FIX ALTO abaixo).
 *   - erro da API (token, rate limit, rede): não decide nada no escuro, só
 *     loga e mantém o estado pendente pra tentar de novo na próxima resposta.
 */
export async function handleFollowCheckReply({
  companyId,
  leadId,
  igsid,
  automationId,
}: {
  companyId: number
  leadId: number
  igsid: string
  automationId: number
}): Promise<{ status: string; error?: string }> {
  // Trava de pausa defensiva: os webhooks já só chamam isto com !lead.botPaused,
  // mas a chave da empresa (Instagram/geral) também vale aqui, e a pausa pode
  // ter sido ligada entre o webhook e este after(). Pausado = não consulta a
  // Graph API, não envia nada e mantém o estado pendente do gate.
  try {
    const [pausedLead] = await db
      .select({ botPaused: recoveryLeads.botPaused })
      .from(recoveryLeads)
      .where(eq(recoveryLeads.id, leadId))
      .limit(1)
    const decision = await isBotBlocked({ companyId, channel: 'instagram', leadBotPaused: pausedLead?.botPaused ?? false })
    if (decision.blocked) return { status: 'ignorado_pausa' }
  } catch (err) {
    console.error(`[Follow Check] Empresa ${companyId}, lead ${leadId}: falha ao ler a pausa; nada enviado:`, err)
    return { status: 'pause_check_failed' }
  }

  const [automation] = await db
    .select()
    .from(instagramCommentAutomations)
    .where(eq(instagramCommentAutomations.id, automationId))
    .limit(1)

  if (!automation) {
    // Automação foi apagada nesse meio tempo: limpa o estado pendente pra
    // não deixar o lead preso pra sempre esperando por algo que não existe.
    await db
      .update(recoveryLeads)
      .set({ pendingFollowCheckAutomationId: null, pendingFollowCheckAttempts: 0 })
      .where(eq(recoveryLeads.id, leadId))
    return { status: 'automation_not_found' }
  }

  const followCheck = await checkInstagramUserFollowsBusiness({ igsid, companyId })

  if (!followCheck.ok) {
    console.error(
      `[Follow Check] Empresa ${companyId}, lead ${leadId}: erro ao consultar Graph API:`,
      followCheck.error,
    )
    // Não manda NADA (nem libera, nem nega) e mantém o estado pendente:
    // decidir com base num erro de API seria decidir no escuro. A próxima
    // resposta da pessoa tenta de novo.
    return { status: 'api_error', error: followCheck.error }
  }

  const igPhone = `ig_${igsid.replace(/^ig_/, '')}`
  const now = new Date()

  if (followCheck.follows) {
    // FIX CRÍTICO de QA (24/09/2026, 2ª rodada): claim-then-act. Antes, o
    // dmMessage real saía ANTES de zerar pendingFollowCheckAutomationId, e
    // duas invocações quase simultâneas (retry/duplicidade real de webhook
    // da Meta, provado por teste) mandavam o conteúdo pago DUAS vezes. Este
    // UPDATE só zera o campo SE ele ainda apontar pra esta automação — quem
    // conseguir essa troca atômica é quem manda a mensagem; quem chegar
    // depois (0 linhas afetadas) desiste sem mandar nada de novo.
    const claimResult = await db.execute<{ id: number }>(sql`
      UPDATE recovery_leads
      SET pending_follow_check_automation_id = NULL,
          pending_follow_check_attempts = 0,
          updated_at = now(),
          last_action_at = now()
      WHERE id = ${leadId} AND pending_follow_check_automation_id = ${automationId}
      RETURNING id
    `)
    const claimedRows = unwrapExecRows<{ id: number }>(claimResult)

    if (claimedRows.length === 0) {
      // FIX de QA (24/09/2026, 3ª rodada): loga o rastro ANTES de desistir.
      // Sem isto, corrida esperada (outra invocação concorrente já
      // reivindicou, comportamento normal) e motivo genuíno (bug futuro
      // zerando o campo na hora errada) ficavam indistinguíveis e
      // completamente silenciosos — quem for investigar "cliente confirmou e
      // não recebeu nada" não achava rastro nenhum no log.
      const [currentLead] = await db
        .select({ pendingFollowCheckAutomationId: recoveryLeads.pendingFollowCheckAutomationId })
        .from(recoveryLeads)
        .where(eq(recoveryLeads.id, leadId))
        .limit(1)
      console.warn(
        `[Follow Check] Empresa ${companyId}, lead ${leadId}: claim de liberação NÃO afetou nenhuma linha ` +
          `(automationId esperado=${automationId}, pending_follow_check_automation_id atual do lead=${
            currentLead ? currentLead.pendingFollowCheckAutomationId ?? 'null' : 'lead não encontrado'
          }). Se o valor atual for null ou outra automação, é corrida esperada com invocação concorrente ` +
          `(comportamento normal, não é erro). Se o valor atual ainda for ${automationId}, investigar: o claim ` +
          `deveria ter afetado a linha.`,
      )
      return { status: 'already_claimed' }
    }

    // Segunda leitura da pausa, colada no envio. O claim acima já zerou o estado
    // pendente; se a pausa ligou enquanto a Graph API respondia, devolve o gate
    // (só se ninguém mexeu nele) pra próxima resposta, depois da reativação, ainda
    // liberar o conteúdo. Nada é enviado nem gravado como enviado.
    if (await followCheckSendBlocked(companyId, leadId, 'liberação')) {
      await db.execute(sql`
        UPDATE recovery_leads
        SET pending_follow_check_automation_id = ${automationId},
            updated_at = now()
        WHERE id = ${leadId} AND pending_follow_check_automation_id IS NULL
      `)
      return { status: 'ignorado_pausa' }
    }

    const sendResult = await sendInstagramMessage({
      recipientId: igsid,
      text: automation.dmMessage,
      companyId,
    })

    if (!sendResult.ok) {
      console.error(
        `[Follow Check] Empresa ${companyId}, lead ${leadId}: falha ao enviar dmMessage real depois de reivindicar a liberação:`,
        sendResult.error,
      )
    }

    await db.insert(whatsappMessages).values({
      companyId,
      leadId,
      phone: igPhone,
      channel: 'instagram',
      direction: 'outbound',
      content: automation.dmMessage,
      messageType: 'text',
      sentBy: 'bot',
      externalId: sendResult.messageId ?? null,
    })

    return { status: sendResult.ok ? 'released' : 'send_failed', error: sendResult.error }
  }

  // Não segue ainda: conta mais uma tentativa sem confirmar. A condição no
  // WHERE (pendingFollowCheckAutomationId = automationId) é a mesma trava de
  // "reivindicar antes de agir": se o estado já mudou (outra invocação
  // liberou/zerou nesse meio tempo), este UPDATE não afeta nenhuma linha e
  // não faz sentido reforçar "segue lá" por cima de um estado que já mudou.
  const [afterIncrement] = await db
    .update(recoveryLeads)
    .set({ pendingFollowCheckAttempts: sql`coalesce(${recoveryLeads.pendingFollowCheckAttempts}, 0) + 1` })
    .where(and(eq(recoveryLeads.id, leadId), eq(recoveryLeads.pendingFollowCheckAutomationId, automationId)))
    .returning({
      pendingFollowCheckAttempts: recoveryLeads.pendingFollowCheckAttempts,
      notes: recoveryLeads.notes,
      botPaused: recoveryLeads.botPaused,
    })

  if (!afterIncrement) {
    // FIX de QA (24/09/2026, 3ª rodada): mesmo rastro do claim acima, aqui pro
    // caso do incremento de tentativa. Corrida esperada (outra invocação já
    // liberou/zerou o gate nesse meio tempo) e motivo genuíno ficavam do
    // mesmo jeito indistinguíveis e silenciosos.
    const [currentLead] = await db
      .select({ pendingFollowCheckAutomationId: recoveryLeads.pendingFollowCheckAutomationId })
      .from(recoveryLeads)
      .where(eq(recoveryLeads.id, leadId))
      .limit(1)
    console.warn(
      `[Follow Check] Empresa ${companyId}, lead ${leadId}: incremento de tentativa NÃO afetou nenhuma linha ` +
        `(automationId esperado=${automationId}, pending_follow_check_automation_id atual do lead=${
          currentLead ? currentLead.pendingFollowCheckAutomationId ?? 'null' : 'lead não encontrado'
        }). Se o valor atual for null ou outra automação, é corrida esperada com invocação concorrente que já ` +
        `liberou/zerou o gate (comportamento normal, não é erro). Se o valor atual ainda for ${automationId}, ` +
        `investigar: o incremento deveria ter afetado a linha.`,
    )
    return { status: 'state_changed' }
  }

  if ((afterIncrement.pendingFollowCheckAttempts ?? 0) >= MAX_FOLLOW_CHECK_ATTEMPTS) {
    // FIX ALTO de QA (24/09/2026, 2ª rodada): desiste do gate. Zera o estado,
    // deixa uma nota no CRM nativo do lead (campo `notes`, o mesmo que
    // qualquer agente vê no Inbox) pra um humano entender por que o gate
    // saiu do ar, e devolve ESTA MESMA mensagem que acabou de chegar pro
    // fluxo normal de IA — sem isso, a mensagem simplesmente não teria
    // resposta nenhuma neste turno.
    const noteText = `[Gate de seguidor] "${automation.name}": lead não confirmou seguir após ${MAX_FOLLOW_CHECK_ATTEMPTS} tentativas em ${now.toISOString()}. Gate desativado, atendimento normal retomado.`
    const updatedNotes = afterIncrement.notes ? `${afterIncrement.notes}\n${noteText}` : noteText

    await db
      .update(recoveryLeads)
      .set({
        pendingFollowCheckAutomationId: null,
        pendingFollowCheckAttempts: 0,
        notes: updatedNotes,
        updatedAt: now,
      })
      .where(eq(recoveryLeads.id, leadId))

    // Só devolve pra IA se ninguém pausou o bot nesse meio tempo (checagem
    // fresca, veio do mesmo UPDATE acima): pendente + pausado nunca deveria
    // gerar mensagem automática nenhuma (mesma regra dos webhooks).
    if (!afterIncrement.botPaused) {
      await generateAndSendAiReply(leadId).catch(err =>
        console.error(
          `[Follow Check] Empresa ${companyId}, lead ${leadId}: erro ao devolver a conversa pro fluxo normal de IA depois do limite de tentativas:`,
          err,
        ),
      )
    }

    return { status: 'gate_abandoned_after_max_attempts' }
  }

  const [config] = await db
    .select({ instagramUsername: settings.instagramUsername })
    .from(settings)
    .where(eq(settings.companyId, companyId))
    .limit(1)
  const deniedText = buildFollowCheckDenied(config?.instagramUsername)

  // Segunda leitura da pausa, colada no envio do reforço. A tentativa que acabou
  // de ser contada não pode penalizar o lead por uma pausa: desfaz o incremento.
  if (await followCheckSendBlocked(companyId, leadId, 'reforço')) {
    await db
      .update(recoveryLeads)
      .set({ pendingFollowCheckAttempts: sql`greatest(coalesce(${recoveryLeads.pendingFollowCheckAttempts}, 0) - 1, 0)` })
      .where(and(eq(recoveryLeads.id, leadId), eq(recoveryLeads.pendingFollowCheckAutomationId, automationId)))
    return { status: 'ignorado_pausa' }
  }

  const sendResult = await sendInstagramMessage({
    recipientId: igsid,
    text: deniedText,
    companyId,
  })

  await db.insert(whatsappMessages).values({
    companyId,
    leadId,
    phone: igPhone,
    channel: 'instagram',
    direction: 'outbound',
    content: deniedText,
    messageType: 'text',
    sentBy: 'bot',
    externalId: sendResult.messageId ?? null,
  })

  return { status: 'still_pending', error: sendResult.error }
}
