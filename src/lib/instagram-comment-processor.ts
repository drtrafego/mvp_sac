import { db } from '@/lib/db'
import {
  instagramCommentAutomations,
  instagramCommentLogs,
  recoveryLeads,
  settings,
  whatsappMessages,
} from '@/lib/db/schema'
import {
  sendInstagramPrivateReply,
  sendInstagramMessage,
  replyInstagramCommentPublic,
  hideInstagramComment,
  checkInstagramUserFollowsBusiness,
} from '@/lib/instagram'
import { eq, and, gte, sql } from 'drizzle-orm'

export interface CommentEventData {
  companyId: number
  commentId: string
  commenterId: string
  commenterUsername?: string
  mediaId: string
  commentText: string
}

/**
 * Normaliza strings para comparação (minúsculas, remove acentos e pontuação extra)
 */
function normalizeText(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
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
function matchesKeywords(
  commentText: string,
  keywordsStr: string | null | undefined,
  matchType: string
): { matched: boolean; matchedKeyword?: string } {
  if (matchType === 'any') {
    return { matched: true, matchedKeyword: '*' }
  }

  if (!keywordsStr || !keywordsStr.trim()) {
    return { matched: false }
  }

  const normalizedComment = normalizeText(commentText)
  const keywordsList = keywordsStr
    .split(',')
    .map(k => normalizeText(k))
    .filter(Boolean)

  if (keywordsList.length === 0) {
    return { matched: false }
  }

  if (matchType === 'exact') {
    for (const kw of keywordsList) {
      if (normalizedComment === kw) {
        return { matched: true, matchedKeyword: kw }
      }
    }
    return { matched: false }
  }

  // matchType === 'contains' (padrão)
  for (const kw of keywordsList) {
    // Busca como palavra completa ou sequência
    const regex = new RegExp(`(^|\\s|[.,!?;])${kw}($|\\s|[.,!?;])`, 'i')
    if (regex.test(normalizedComment) || normalizedComment.includes(kw)) {
      return { matched: true, matchedKeyword: kw }
    }
  }

  return { matched: false }
}

/**
 * Textos do gate de seguidor (24/09/2026). Não são configuráveis por
 * automação de propósito (o pedido foi só o flag liga/desliga, ver
 * comentário em schema.ts): manter fixo evita mais um campo de texto pra
 * validar/testar sem necessidade real hoje.
 */
function buildFollowCheckQuestion(username?: string | null): string {
  const handle = username ? `@${username}` : 'a nossa conta'
  return `Oi! Antes de eu te mandar o conteúdo, só preciso confirmar uma coisa: você já segue ${handle} aqui no Instagram? Responde aqui que eu libero na hora!`
}

function buildFollowCheckDenied(username?: string | null): string {
  const handle = username ? `@${username}` : 'a nossa conta'
  return `Ainda não te encontrei seguindo ${handle}. Segue lá e me responde de novo (um "pronto" já serve) que eu libero o conteúdo certinho pra você!`
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
  const applicableAutomations = automations.filter(rule => {
    if (!rule.mediaId) return true // regra global para todos os posts
    return rule.mediaId === mediaId
  })

  if (applicableAutomations.length === 0) {
    return { status: 'skipped', reason: 'no_matching_post_rule' }
  }

  // 4. Encontra a primeira regra que casa com o horário e as palavras-chave
  let matchedRule: typeof automations[0] | null = null
  let matchedKeywordFound: string | undefined

  for (const rule of applicableAutomations) {
    // Checa janela de horários
    if (!isWithinActiveHours(rule.activeHoursStart, rule.activeHoursEnd)) {
      continue
    }

    const { matched, matchedKeyword } = matchesKeywords(commentText, rule.keywords, rule.matchType)
    if (matched) {
      matchedRule = rule
      matchedKeywordFound = matchedKeyword
      break
    }
  }

  if (!matchedRule) {
    return { status: 'skipped', reason: 'no_keyword_matched' }
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

  // 6. Disparo da Resposta Privada (Private Reply) via Graph API.
  // Automação com requireFollowCheck: NÃO manda o dmMessage ainda, manda a
  // pergunta intermediária (ver comentário no schema.ts). O conteúdo real só
  // sai depois que a pessoa responder e a Graph API confirmar que ela segue
  // a conta (handleFollowCheckReply, chamado pelo webhook inbound).
  let sentText = matchedRule.dmMessage
  if (matchedRule.requireFollowCheck) {
    const [config] = await db
      .select({ instagramUsername: settings.instagramUsername })
      .from(settings)
      .where(eq(settings.companyId, companyId))
      .limit(1)
    sentText = buildFollowCheckQuestion(config?.instagramUsername)
  }

  const dmResult = await sendInstagramPrivateReply({
    commentId,
    text: sentText,
    companyId,
  })

  if (!dmResult.ok) {
    console.error(`[Comment-to-DM Error] Empresa ${companyId}, comment ${commentId}:`, dmResult.error)
    await db.insert(instagramCommentLogs).values({
      companyId,
      automationId: matchedRule.id,
      commentId,
      commenterId,
      commenterUsername,
      mediaId,
      commentText,
      matchedKeyword: matchedKeywordFound,
      status: 'failed',
      errorMessage: dmResult.error,
    }).onConflictDoNothing()
    return { status: 'failed', error: dmResult.error }
  }

  // 7. Sucesso no Envio da DM: grava log e incrementa contador da automação
  const now = new Date()
  await db.insert(instagramCommentLogs).values({
    companyId,
    automationId: matchedRule.id,
    commentId,
    commenterId,
    commenterUsername,
    mediaId,
    commentText,
    matchedKeyword: matchedKeywordFound,
    status: 'sent',
    sentAt: now,
  }).onConflictDoNothing()

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
      .where(eq(recoveryLeads.phone, igPhone))
      .limit(1)

    // Não-nulo só quando esta automação exige o gate de seguidor: marca o
    // lead como aguardando a resposta dele pra checar is_user_follow_business
    // de verdade (ver comentário completo em schema.ts). Automação sem o
    // flag não toca este campo, e se ele já estivesse preenchido por OUTRA
    // automação anterior, esta escrita nova (mesmo null) o substitui por
    // simplicidade: só um fluxo pendente por vez, decisão documentada ali.
    const pendingFollowCheckAutomationId = matchedRule.requireFollowCheck ? matchedRule.id : null

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
          pendingFollowCheckAutomationId,
        })
        .returning()
      lead = newLead
    } else {
      await db
        .update(recoveryLeads)
        .set({
          updatedAt: now,
          // lastActionAt precisa entrar aqui: o COALESCE de ordenação do
          // Inbox trava no primeiro valor não nulo, então a DM enviada pelo
          // comentário automático não subia a conversa quando lastActionAt
          // já existia de antes.
          lastActionAt: now,
          channel: 'instagram',
          name: lead.name && !lead.name.startsWith('Instagram Direct') ? lead.name : displayName,
          pendingFollowCheckAutomationId,
        })
        .where(eq(recoveryLeads.id, lead.id))
    }

    // Grava a mensagem enviada (pergunta intermediária ou dmMessage direto,
    // dependendo do gate) na tabela unificada de mensagens
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
 * Segunda etapa do gate de seguidor (24/09/2026): chamado pelo webhook
 * inbound do Instagram (route.ts e [slug]/route.ts) quando o lead que
 * respondeu tem `pendingFollowCheckAutomationId` setado, em vez de cair no
 * generateAndSendAiReply normal. Confere de verdade via Graph API
 * (is_user_follow_business) e decide:
 *   - segue: libera o dmMessage real da automação e limpa o estado pendente.
 *   - não segue: reforça o pedido pra seguir e MANTÉM o estado pendente, pra
 *     checar de novo na próxima resposta dela.
 *   - erro da API (token, rate limit, rede): não decide nada no escuro, só
 *     loga e mantém o estado pendente pra tentar de novo na próxima resposta
 *     (nenhum limite de tentativas foi pedido, então não inventamos um).
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
      .set({ pendingFollowCheckAutomationId: null })
      .where(eq(recoveryLeads.id, leadId))
    return { status: 'automation_not_found' }
  }

  const followCheck = await checkInstagramUserFollowsBusiness({ igsid, companyId })

  if (!followCheck.ok) {
    console.error(
      `[Follow Check] Empresa ${companyId}, lead ${leadId}: erro ao consultar Graph API:`,
      followCheck.error,
    )
    return { status: 'api_error', error: followCheck.error }
  }

  const igPhone = `ig_${igsid.replace(/^ig_/, '')}`
  const now = new Date()

  if (followCheck.follows) {
    const sendResult = await sendInstagramMessage({
      recipientId: igsid,
      text: automation.dmMessage,
      companyId,
    })

    if (sendResult.ok) {
      await db
        .update(recoveryLeads)
        .set({ pendingFollowCheckAutomationId: null, updatedAt: now, lastActionAt: now })
        .where(eq(recoveryLeads.id, leadId))
    } else {
      console.error(
        `[Follow Check] Empresa ${companyId}, lead ${leadId}: falha ao enviar dmMessage real:`,
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

  // Não segue ainda: reforça o pedido e MANTÉM pendingFollowCheckAutomationId
  // (não mexe nele) pra checar de novo quando ela responder de novo.
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
