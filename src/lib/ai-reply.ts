// Motor de resposta automática da IA (Nina/AutonomIA, Amanda). Chamado pelo
// webhook via `after()`, depois da mensagem inbound já estar gravada e da
// resposta HTTP do webhook já ter saído: nada aqui pode atrasar a Meta.
//
// Mudança de arquitetura (19/09/2026, ordem do Gastão): este SAC NÃO chama
// mais nenhuma API de IA direto. Ele pede o texto pronto pra ponte da Luana
// (`gerarResposta`, em lib/ai/ai-bridge.ts), que fala com o cérebro DE
// VERDADE da Nina/Amanda (o mesmo claude -p / SOUL que já atende em
// produção) e já aplica, do lado dela, as travas de conteúdo (vazamento,
// sinal interno etc. do receiver.py). Evita duplicar aquela lógica aqui.
//
// O que sobra pro SAC é o FLUXO: quando chamar (respeitar botPaused e o
// gate por empresa), pra quem enviar, o rate limit da NOSSA aplicação, e
// executar de verdade a ação de agenda que a ponte apenas detectar
// (`acao_detectada`) — a ponte só gera texto, nunca mexe na agenda sozinha.

import { eq, desc, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { recoveryLeads, settings, whatsappMessages, companies } from '@/lib/db/schema'
import { sendWhatsAppMessage } from '@/lib/whatsapp'
import { sendInstagramMessage } from '@/lib/instagram'
import { resolveLeadDeliveryChannel } from '@/lib/lead-delivery-channel'
import { gerarResposta, type Bot, type HistoricoTurno } from '@/lib/ai/ai-bridge'
import { executarAcaoDetectada, type AiScheduleState } from '@/lib/ai/agenda-actions'
import { detectarBotDoOutroLado, type TurnoComTempo } from '@/lib/ai/bot-detector'

// Rede de segurança contra processo morto no meio (função da Vercel
// derrubada por timeout com o lock preso): depois deste tempo o lock é
// considerado abandonado e outra chamada pode assumir.
const LOCK_TIMEOUT_MINUTOS = 3

/**
 * Lock otimista por lead (UPDATE atômico condicional, mesmo padrão do
 * rate-limit local da ponte em src/lib/ai/ai-bridge.ts): quem conseguir o
 * UPDATE processa esta rodada, quem não conseguir desiste sem erro. Evita
 * que duas mensagens em sequência rápida do mesmo lead disparem duas
 * chamadas concorrentes de generateAndSendAiReply pro mesmo lead.
 */
async function tentarAdquirirLock(leadId: number): Promise<boolean> {
  const result = await db.execute<{ id: number }>(sql`
    UPDATE recovery_leads
    SET ai_reply_lock_at = now()
    WHERE id = ${leadId}
      AND (ai_reply_lock_at IS NULL OR ai_reply_lock_at < now() - make_interval(mins => ${LOCK_TIMEOUT_MINUTOS}))
    RETURNING id
  `)
  return result.rows.length > 0
}

async function liberarLock(leadId: number): Promise<void> {
  try {
    await db.execute(sql`UPDATE recovery_leads SET ai_reply_lock_at = NULL WHERE id = ${leadId}`)
  } catch (err) {
    console.error(`[AI Reply] falha ao liberar lock lead=${leadId} (timeout de ${LOCK_TIMEOUT_MINUTOS}min garante que ele destrava sozinho):`, err)
  }
}

// "até 20 mais recentes" é o limite documentado da ponte pro campo `historico`.
const HISTORICO_LIMITE = 20

// Bot que a ponte espera receber, por slug de empresa (ver seeds em
// src/lib/db/index.ts: 'autonomia' = AutonomIA/Nina, 'amanda' = Amanda Felix).
// Empresa fora deste mapa não tem bot na ponte: resposta automática pulada.
const BOT_POR_SLUG: Record<string, Bot> = {
  autonomia: 'nina',
  amanda: 'amanda',
}

function nomeExibicaoDoBot(bot: Bot): string {
  return bot === 'nina' ? 'Nina' : 'Amanda'
}

type LinhaMensagem = {
  direction: string
  content: string | null
  messageType: string | null
  createdAt?: Date | null
}

function textoDaLinha(m: LinhaMensagem): string {
  return m.content && m.content.trim() ? m.content : `[${m.messageType || 'mídia'}]`
}

function montarHistorico(linhas: LinhaMensagem[]): HistoricoTurno[] {
  return linhas.map((m) => ({
    role: m.direction === 'inbound' ? 'lead' : 'bot',
    text: textoDaLinha(m),
  }))
}

function montarCronologiaComTempo(linhas: LinhaMensagem[]): TurnoComTempo[] {
  return linhas.map((m) => ({
    role: m.direction === 'inbound' ? 'lead' : 'bot',
    text: textoDaLinha(m),
    createdAt: m.createdAt,
  }))
}

/**
 * Gera e envia a resposta automática de IA pra um lead, se a empresa dele
 * tiver a IA ligada (`aiSystemPrompt` preenchido, hoje só um gate manual) e
 * o bot não estiver pausado por um humano. Projetada pra rodar dentro de
 * `after()`, então nunca lança: qualquer falha só loga e desiste desta
 * rodada (a próxima mensagem do lead tenta de novo).
 */
export async function generateAndSendAiReply(leadId: number): Promise<void> {
  let lockAdquirido = false
  try {
    lockAdquirido = await tentarAdquirirLock(leadId)
    if (!lockAdquirido) {
      console.log(`[AI Reply] lock ocupado lead=${leadId}, pulando esta chamada (a próxima mensagem do lead vai reler o histórico já atualizado e responder as duas juntas)`)
      return
    }

    const [lead] = await db.select().from(recoveryLeads).where(eq(recoveryLeads.id, leadId)).limit(1)
    if (!lead) return
    if (lead.botPaused) return

    const [config] = await db.select().from(settings).where(eq(settings.companyId, lead.companyId)).limit(1)
    if (!config?.aiSystemPrompt) return // gate manual: empresa sem IA ligada não recebe reply automático

    const [company] = await db.select().from(companies).where(eq(companies.id, lead.companyId)).limit(1)
    const bot = company ? BOT_POR_SLUG[company.slug] : undefined
    if (!bot) {
      console.error(`[AI Reply] empresa=${lead.companyId} (slug=${company?.slug ?? '?'}) sem bot mapeado na ponte, pulando lead=${leadId}`)
      return
    }

    // busca até HISTORICO_LIMITE + 1: a mais recente é a mensagem atual
    // (já gravada pelo webhook antes de chamar esta função), o resto vira
    // o `historico` que a ponte espera, em ordem cronológica.
    const linhas = await db
      .select({
        direction: whatsappMessages.direction,
        content: whatsappMessages.content,
        messageType: whatsappMessages.messageType,
        createdAt: whatsappMessages.createdAt,
      })
      .from(whatsappMessages)
      .where(eq(whatsappMessages.leadId, leadId))
      .orderBy(desc(whatsappMessages.createdAt))
      .limit(HISTORICO_LIMITE + 1)

    if (linhas.length === 0) return
    const [ultima, ...anteriores] = linhas
    const anterioresAsc = anteriores.reverse() // cronológico, mais antiga primeiro
    const mensagemAtual = textoDaLinha(ultima)
    const historico = montarHistorico(anterioresAsc)

    // Anti-loop: do outro lado é uma máquina? Mesma lógica de
    // detector_bot.py da Luana, rodando ANTES da ponte pra não gastar rate
    // limit (nem arriscar loop de bot-com-bot) numa conversa que não é com
    // gente de verdade. Ver src/lib/ai/bot-detector.ts.
    const cronologiaCompleta = montarCronologiaComTempo([...anterioresAsc, ultima])
    const deteccao = detectarBotDoOutroLado(cronologiaCompleta)
    if (deteccao.bot) {
      console.error(
        `[AI Reply] BOT_DO_OUTRO_LADO lead=${leadId} pontos=${deteccao.pontos} msgs_lead=${deteccao.msgsLead} ` +
          `sinais=${deteccao.sinais.join(',')}. Pulando a ponte (anti-loop), fica pro atendimento humano.`,
      )
      await db
        .update(recoveryLeads)
        .set({
          botPaused: true,
          botPausedAt: new Date(),
          botPausedBy: `Anti-loop (bot do outro lado detectado: ${deteccao.sinais.join(', ')}, pontos=${deteccao.pontos})`,
        })
        .where(eq(recoveryLeads.id, leadId))
      return
    }

    const state: AiScheduleState = (lead.aiScheduleState as AiScheduleState) || {}
    const agendamentoAtual = Object.keys(state).length > 0 ? state : null

    const resultado = await gerarResposta({
      bot,
      mensagem: mensagemAtual,
      historico,
      nomeContato: lead.name || '',
      waId: lead.phone,
      agendamentoAtual,
    })

    if (!resultado.ok) {
      console.error(
        `[AI Reply] ponte indisponível lead=${leadId} motivo=${resultado.motivo}` +
          (resultado.detalhe ? ` detalhe=${resultado.detalhe}` : '') +
          '. Nada enviado, fica pro atendimento humano.',
      )
      return
    }

    const envelope = resultado.resposta

    if (envelope.status === 'sem_resposta') {
      console.log(`[AI Reply] SEM_RESPOSTA lead=${leadId}: a ponte decidiu ficar em silêncio, nada enviado.`)
      return
    }

    let textoFinal = (envelope.resposta || '').trim()
    let novoState = state

    if (envelope.acao_detectada) {
      const resultadoAcao = await executarAcaoDetectada({
        acao: envelope.acao_detectada,
        textoVisivel: textoFinal,
        telefone: lead.phone,
        nomeContato: lead.name || '',
        state,
      })
      textoFinal = resultadoAcao.textoVisivel
      novoState = resultadoAcao.novoState
    }

    // Persiste estado de agenda e/ou o encerramento ANTES de tentar enviar:
    // se a agenda real mudou (ex.: reunião marcada de verdade) ou a
    // conversa acabou, isso não pode se perder só porque o envio da
    // mensagem falhou depois.
    const updateData: Partial<typeof recoveryLeads.$inferInsert> = {}
    if (JSON.stringify(novoState) !== JSON.stringify(state)) {
      updateData.aiScheduleState = novoState
    }
    if (envelope.encerrar) {
      console.log(`[AI Reply] ENCERRAR lead=${leadId}: motivo="${envelope.encerrar.motivo || '(sem motivo)'}". Pausando o bot pra humano assumir.`)
      updateData.botPaused = true
      updateData.botPausedAt = new Date()
      updateData.botPausedBy = `IA (encerrou: ${envelope.encerrar.motivo || 'sem motivo informado'})`
    }
    if (Object.keys(updateData).length > 0) {
      await db.update(recoveryLeads).set(updateData).where(eq(recoveryLeads.id, leadId))
    }

    if (!textoFinal.trim()) {
      console.error(`[AI Reply] texto final vazio (status=${envelope.status}), lead=${leadId}, nada enviado.`)
      return
    }

    const deliveryChannel = resolveLeadDeliveryChannel(lead)
    if (deliveryChannel === 'instagram') {
      const result = await sendInstagramMessage({ recipientId: lead.phone, text: textoFinal, companyId: lead.companyId })
      if (!result.ok) {
        console.error(`[AI Reply] falha ao enviar Instagram lead=${leadId}: ${result.error}`)
        return
      }
    } else {
      await sendWhatsAppMessage(lead.phone, { type: 'text', content: textoFinal }, lead.companyId)
    }

    await db.insert(whatsappMessages).values({
      companyId: lead.companyId,
      leadId: lead.id,
      phone: lead.phone,
      channel: deliveryChannel === 'instagram' ? deliveryChannel : (lead.channel || 'whatsapp'),
      direction: 'outbound',
      content: textoFinal,
      messageType: 'text',
      sentBy: 'bot',
      senderName: nomeExibicaoDoBot(bot),
      agentId: bot,
    })

    // Sem isto, a resposta do bot nunca bumpava lastActionAt/updatedAt:
    // no WhatsApp a mensagem inbound anterior já tinha atualizado (mascarando
    // o problema), mas no Instagram nem o inbound nem este outbound tocavam
    // lastActionAt, e a conversa ficava congelada na ordenação do Inbox
    // mesmo com a IA respondendo ativamente.
    await db
      .update(recoveryLeads)
      .set({ lastActionAt: new Date(), updatedAt: new Date() })
      .where(eq(recoveryLeads.id, lead.id))
  } catch (err) {
    console.error(`[AI Reply] erro inesperado gerando resposta pra lead=${leadId}:`, err)
  } finally {
    if (lockAdquirido) {
      await liberarLock(leadId)
    }
  }
}
