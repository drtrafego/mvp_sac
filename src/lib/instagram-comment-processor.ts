import { db } from '@/lib/db'
import {
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
import { eq, and, gte, sql } from 'drizzle-orm'
import { matchesCommentKeywords } from '@/lib/instagram-comment-keywords'
import { normalizeTag } from '@/lib/lead-tags'
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
    if (!rule.mediaId) return true // regra global para todos os posts
    return rule.mediaId === mediaId
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

  // 5. Deduplicação por Usuário + Post + Regra (não reenviar DM se já enviou pelo mesmo post)
  if (mediaId) {
    const [alreadySentToUser] = await db
      .select({ id: instagramCommentLogs.id })
      .from(instagramCommentLogs)
      .where(
        and(
          eq(instagramCommentLogs.automationId, matchedRule.id),
          eq(instagramCommentLogs.commenterId, commenterId),
          eq(instagramCommentLogs.mediaId, mediaId),
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
  const [claim] = await db.insert(instagramCommentLogs).values({
    companyId,
    automationId: matchedRule.id,
    commentId,
    commenterId,
    commenterUsername,
    mediaId,
    commentText,
    matchedKeyword: matchedKeywordFound,
    status: 'processing',
  }).onConflictDoNothing().returning({ id: instagramCommentLogs.id })
  if (!claim) return { status: 'skipped', reason: 'comment_claim_already_exists' }

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
      const [newLead] = await db
        .insert(recoveryLeads)
        .values({
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
