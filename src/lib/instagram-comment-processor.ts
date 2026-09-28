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
import { generateAndSendAiReply } from '@/lib/ai-reply'
import { eq, and, gte, sql } from 'drizzle-orm'
import { matchesCommentKeywords } from '@/lib/instagram-comment-keywords'

export interface CommentEventData {
  companyId: number
  commentId: string
  commenterId: string
  commenterUsername?: string
  mediaId: string
  commentText: string
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
          pendingFollowCheckAutomationId: matchedRule.requireFollowCheck ? matchedRule.id : null,
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
        updateSet.pendingFollowCheckAutomationId = matchedRule.id
        updateSet.pendingFollowCheckAttempts = 0
      }

      await db.update(recoveryLeads).set(updateSet).where(eq(recoveryLeads.id, lead.id))
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
