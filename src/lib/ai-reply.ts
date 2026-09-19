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

import { eq, desc } from 'drizzle-orm'
import { db } from '@/lib/db'
import { recoveryLeads, settings, whatsappMessages, companies } from '@/lib/db/schema'
import { sendWhatsAppMessage } from '@/lib/whatsapp'
import { sendInstagramMessage } from '@/lib/instagram'
import { gerarResposta, type Bot, type HistoricoTurno } from '@/lib/ai/ai-bridge'
import { executarAcaoDetectada, type AiScheduleState } from '@/lib/ai/agenda-actions'

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

function montarHistorico(
  linhas: { direction: string; content: string | null; messageType: string | null }[],
): HistoricoTurno[] {
  return linhas.map((m) => ({
    role: m.direction === 'inbound' ? 'lead' : 'bot',
    text: m.content && m.content.trim() ? m.content : `[${m.messageType || 'mídia'}]`,
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
  try {
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
      })
      .from(whatsappMessages)
      .where(eq(whatsappMessages.leadId, leadId))
      .orderBy(desc(whatsappMessages.createdAt))
      .limit(HISTORICO_LIMITE + 1)

    if (linhas.length === 0) return
    const [ultima, ...anteriores] = linhas
    const mensagemAtual = ultima.content && ultima.content.trim() ? ultima.content : `[${ultima.messageType || 'mídia'}]`
    const historico = montarHistorico(anteriores.reverse())

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

    if (lead.channel === 'instagram') {
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
      channel: lead.channel || 'whatsapp',
      direction: 'outbound',
      content: textoFinal,
      messageType: 'text',
      sentBy: 'bot',
      senderName: nomeExibicaoDoBot(bot),
      agentId: bot,
    })
  } catch (err) {
    console.error(`[AI Reply] erro inesperado gerando resposta pra lead=${leadId}:`, err)
  }
}
