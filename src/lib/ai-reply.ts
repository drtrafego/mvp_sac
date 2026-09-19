// Motor de resposta automática da IA (Fase 1, Nina/AutonomIA). Chamado pelo
// webhook via `after()`, depois da mensagem inbound já estar gravada e da
// resposta HTTP do webhook já ter saído: nada aqui pode atrasar a Meta.
//
// Ordem de segurança, igual ao receiver.py (não é acidente, é a ordem que
// evitou incidente real lá): sinal interno ANTES de suspeita, suspeita nunca
// deixa "já te respondo" repetir, marcador de agendamento só roda depois de
// passar pelas duas.

import { eq, desc } from 'drizzle-orm'
import { db } from '@/lib/db'
import { recoveryLeads, settings, whatsappMessages } from '@/lib/db/schema'
import { sendWhatsAppMessage } from '@/lib/whatsapp'
import { sendInstagramMessage } from '@/lib/instagram'
import {
  ehSinalInterno,
  mensagemSuspeita,
  FALLBACK_GENERICO,
  removerMarcadorEncerrar,
} from '@/lib/ai/security-filters'
import {
  processarMarcadores,
  formatarSlotsParaPrompt,
  type AiScheduleState,
} from '@/lib/ai/scheduling-markers'

const HISTORICO_LIMITE = 40
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'
const ANTHROPIC_MAX_TOKENS = 500

type ChatMsg = { role: 'user' | 'assistant'; content: string }

function montarMensagens(
  historico: { direction: string; content: string | null; messageType: string | null }[],
): ChatMsg[] {
  const brutas: ChatMsg[] = historico.map((m) => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.content && m.content.trim() ? m.content : `[${m.messageType || 'mídia'}]`,
  }))

  // A Messages API exige alternância estrita de papel: funde turnos
  // consecutivos do mesmo lado em vez de mandar dois "user" seguidos.
  const fundidas: ChatMsg[] = []
  for (const m of brutas) {
    const ultima = fundidas[fundidas.length - 1]
    if (ultima && ultima.role === m.role) {
      ultima.content += `\n${m.content}`
    } else {
      fundidas.push({ ...m })
    }
  }

  // e exige que a conversa comece com 'user'.
  while (fundidas.length && fundidas[0].role !== 'user') fundidas.shift()
  return fundidas
}

function estadoAgendamentoTexto(state: AiScheduleState): string {
  if (state.eventId) {
    return (
      `Já existe uma reunião marcada com este lead: ${state.start ?? '?'} a ${state.end ?? '?'} ` +
      `(nome: ${state.nome ?? '?'}). Se ele pedir pra REMARCAR ou CANCELAR, é ESSA reunião, você não ` +
      `sabe (e não precisa saber) o id, só sinalizar a intenção.`
    )
  }
  if (state.pendingStart) {
    return (
      `O lead já escolheu o horário ${state.pendingStart} a ${state.pendingEnd}, mas AINDA NÃO deu ` +
      `e-mail: não existe reunião real ainda, não anuncie fechamento.`
    )
  }
  return 'Não há reunião marcada com este lead ainda nesta conversa.'
}

async function montarSystemPrompt(opts: {
  soul: string
  nomeContato: string
  state: AiScheduleState
}): Promise<string> {
  const slots = await formatarSlotsParaPrompt()
  return `${opts.soul}

---
CONTEXTO OPERACIONAL (não faz parte do SOUL, é a etapa em que esta conversa está agora):
Nome de contato: ${opts.nomeContato || '(sem nome)'}

HORÁRIOS REAIS LIVRES NA AGENDA (única fonte válida pra oferecer horário; vazio ou com erro = NÃO ofereça horário nenhum, diga que confirma a agenda e já volta):
${slots}

ESTADO DE AGENDAMENTO DESTA CONVERSA: ${estadoAgendamentoTexto(opts.state)}

---
Responda APENAS com o texto que vai pro WhatsApp/Instagram (máximo 3 a 4 linhas, sem aspas, sem comentário seu).

SÓ EXISTE AGENDAMENTO COM HORÁRIO E E-MAIL. Quando tiver os dois, termine sua resposta com uma linha adicional exatamente neste formato (será removida antes de enviar, o agendamento real é feito por fora):
<<BOOK nome="NOME" email="EMAIL" start="ISO_START" end="ISO_END">>
NUNCA escreva essa linha com email="": sem e-mail o sistema não cria evento nenhum.

Se já existe reunião marcada (ver ESTADO DE AGENDAMENTO acima) e o lead confirmou um NOVO horário da lista de HORÁRIOS REAIS LIVRES pra remarcar, termine com:
<<RESCHEDULE start="ISO_START" end="ISO_END">>

Se já existe reunião marcada e o lead confirmou que quer CANCELAR, termine com:
<<CANCEL>>

Só gere UM desses marcadores, só quando tiver certeza, nunca invente id nem horário fora da lista.`
}

async function chamarAnthropic(system: string, messages: ChatMsg[]): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('[AI Reply] ANTHROPIC_API_KEY não configurada, abortando resposta automática')
    return null
  }
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        system,
        messages,
      }),
      signal: AbortSignal.timeout(45_000),
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      console.error(`[AI Reply] Anthropic API erro ${resp.status}: ${errText.slice(0, 500)}`)
      return null
    }
    const data = (await resp.json()) as { content?: { type: string; text?: string }[] }
    const texto = (data.content ?? [])
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text)
      .join('\n')
      .trim()
    return texto || null
  } catch (err) {
    console.error('[AI Reply] exceção chamando Anthropic API:', err)
    return null
  }
}

/**
 * Gera e envia a resposta automática de IA pra um lead, se a empresa dele
 * tiver `aiSystemPrompt` configurado e o bot não estiver pausado por um
 * humano. Projetada pra rodar dentro de `after()`, então nunca lança: qualquer
 * falha só loga e desiste desta rodada (o `vigia`/humano cobre depois, quando
 * essa rede de segurança existir).
 */
export async function generateAndSendAiReply(leadId: number): Promise<void> {
  try {
    const [lead] = await db.select().from(recoveryLeads).where(eq(recoveryLeads.id, leadId)).limit(1)
    if (!lead) return
    if (lead.botPaused) return

    const [config] = await db.select().from(settings).where(eq(settings.companyId, lead.companyId)).limit(1)
    if (!config?.aiSystemPrompt) return // gate: só empresa com SOUL configurado recebe reply automático

    const historico = await db
      .select({
        direction: whatsappMessages.direction,
        content: whatsappMessages.content,
        messageType: whatsappMessages.messageType,
        sentBy: whatsappMessages.sentBy,
      })
      .from(whatsappMessages)
      .where(eq(whatsappMessages.leadId, leadId))
      .orderBy(desc(whatsappMessages.createdAt))
      .limit(HISTORICO_LIMITE)

    const historicoAsc = [...historico].reverse()
    const mensagens = montarMensagens(historicoAsc)
    if (mensagens.length === 0) return

    const ultimaDoBot = [...historicoAsc].reverse().find((m) => m.direction === 'outbound' && m.sentBy === 'bot')
    const ultimaFoiFallback = !!ultimaDoBot?.content?.trim().startsWith(FALLBACK_GENERICO.slice(0, 40))

    const state: AiScheduleState = (lead.aiScheduleState as AiScheduleState) || {}
    const system = await montarSystemPrompt({
      soul: config.aiSystemPrompt,
      nomeContato: lead.name || '',
      state,
    })

    const respostaBruta = await chamarAnthropic(system, mensagens)
    if (!respostaBruta) return

    // SINAL ANTES DE SUSPEITA (mesma ordem do receiver.py): marcador de
    // controle não é resposta vazada, é o modelo pedindo silêncio.
    if (ehSinalInterno(respostaBruta)) {
      console.log(`[AI Reply] SINAL INTERNO lead=${leadId}: nada enviado, nada gravado.`)
      return
    }

    let textoFinal: string
    let novoState = state

    if (mensagemSuspeita(respostaBruta)) {
      console.error(
        `[AI Reply] VAZAMENTO DE IA BLOQUEADO lead=${leadId}: termo da lista de termos proibidos no texto gerado. Original: ${respostaBruta.slice(0, 300)}`,
      )
      if (ultimaFoiFallback) {
        console.error(`[AI Reply] FALLBACK REPETIDO lead=${leadId}: calando, precisa de humano.`)
        return
      }
      textoFinal = FALLBACK_GENERICO
    } else {
      const { texto: semEncerrar } = removerMarcadorEncerrar(respostaBruta)
      const resultado = await processarMarcadores({
        textoBruto: semEncerrar,
        telefone: lead.phone,
        nomeContato: lead.name || '',
        state,
      })
      textoFinal = resultado.textoVisivel
      novoState = resultado.novoState
    }

    if (!textoFinal || !textoFinal.trim()) {
      console.error(`[AI Reply] texto final vazio depois dos filtros, lead=${leadId}, nada enviado.`)
      return
    }

    if (JSON.stringify(novoState) !== JSON.stringify(state)) {
      await db.update(recoveryLeads).set({ aiScheduleState: novoState }).where(eq(recoveryLeads.id, leadId))
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
      senderName: 'Nina',
      agentId: 'nina',
    })
  } catch (err) {
    console.error(`[AI Reply] erro inesperado gerando resposta pra lead=${leadId}:`, err)
  }
}
