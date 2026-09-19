// Execução real da ação de agenda que a ponte da Nina/Amanda (Luana) já
// detecta pronta em `acao_detectada` (book | reschedule | cancel). A ponte
// só GERA texto e reconhece a intenção do lead; quem chama a API de agenda
// de verdade (Google Calendar via agenda-autonomia.ts) é este SAC, sempre.
// Nunca assuma que a ponte já agendou/remarcou/cancelou nada sozinha.
//
// Trava central, herdada do desenho anterior (processar_resposta() do
// receiver.py, e da versão 1 deste arquivo baseada em marcadores de texto
// tipo <<BOOK ...>>): NUNCA deixar a fala que vai pro lead anunciar um
// agendamento que não aconteceu de verdade. Falha ou recusa da API de
// agenda troca a resposta inteira por uma frase de handoff, nunca deixa
// "fechado!" passar.
//
// O modelo do lado da ponte nunca sabe o id do evento no Google Calendar:
// quem guarda isso é `aiScheduleState` do lead, aqui no SAC.

import { marcarReuniao, remarcarReuniao, cancelarReuniao } from '@/lib/agenda-autonomia'
import { pareceFechamento, textoDeRecusa, textoPedeDados } from './security-filters'
import type { AcaoDetectada } from './ai-bridge'

export type AiScheduleState = {
  eventId?: string
  start?: string
  end?: string
  nome?: string
  email?: string
  pendingStart?: string
  pendingEnd?: string
  pendingNome?: string
}

const NAO_ACHOU_REUNIAO =
  '\n\nNão encontrei uma reunião marcada pra você aqui, deixa eu confirmar com o time.'

const MOVER_RECUSADO =
  'Opa, não consegui mexer nesse horário agora. Seu horário atual continua de pé. Quer que eu veja outra opção, ou o time confirma com você em instantes?'

const CANCELAR_RECUSADO =
  '\n\nNão consegui cancelar agora, o time confirma com você em instantes.'

/**
 * Executa a ação que a ponte detectou (`acao_detectada`) e devolve o texto
 * final (que pode substituir integralmente o `resposta` da ponte, se a ação
 * falhar) e o novo `aiScheduleState` do lead.
 */
export async function executarAcaoDetectada(opts: {
  acao: AcaoDetectada
  textoVisivel: string
  telefone: string
  nomeContato: string
  state: AiScheduleState
}): Promise<{ textoVisivel: string; novoState: AiScheduleState }> {
  const { acao, telefone, nomeContato } = opts
  let state: AiScheduleState = { ...opts.state }
  const textoVisivel = opts.textoVisivel

  if (acao.tipo === 'book') {
    const nome = acao.nome || ''
    const email = acao.email || ''
    let start = acao.start || ''
    let end = acao.end || ''

    // e-mail chegou mas a ponte não repetiu o horário: usa o pendente
    // guardado na rodada anterior (lead já tinha escolhido um slot).
    if (!(start && end) && email && state.pendingStart && state.pendingEnd) {
      start = state.pendingStart
      end = state.pendingEnd
    }

    if (!(start && end)) {
      console.error(`[Agenda Actions] BOOK sem horário e sem pendente, ignorado (tel=...${telefone.slice(-4)})`)
      return { textoVisivel, novoState: state }
    }

    if (state.eventId) {
      // já existe reunião: só mexe se o horário realmente mudou.
      const mudouHorario = start !== state.start || end !== state.end
      if (!mudouHorario) return { textoVisivel, novoState: state }
      try {
        const r = await remarcarReuniao({ eventId: state.eventId, telefone, start, end })
        if (!r.ok) {
          console.error(`[Agenda Actions] remarcar (via BOOK) recusado: ${r.erro || r.detalhe}`)
          return { textoVisivel: MOVER_RECUSADO, novoState: state }
        }
        state = { ...state, start, end }
        return { textoVisivel, novoState: state }
      } catch (err) {
        console.error('[Agenda Actions] remarcarReuniao (via BOOK) falhou:', err)
        return { textoVisivel: textoDeRecusa(undefined), novoState: state }
      }
    }

    if (!email) {
      // horário escolhido, mas sem e-mail: NADA vai pra agenda ainda.
      state = { ...state, pendingStart: start, pendingEnd: end, pendingNome: nome || state.pendingNome }
      const semAnunciarFechamento =
        !textoVisivel || pareceFechamento(textoVisivel) ? textoPedeDados(nome || nomeContato) : textoVisivel
      return { textoVisivel: semAnunciarFechamento, novoState: state }
    }

    try {
      const r = await marcarReuniao({
        nome: nome || nomeContato || 'lead do WhatsApp',
        telefone,
        email,
        start,
        end,
      })
      if (!r.ok || !r.event_id) {
        console.error(`[Agenda Actions] BOOK recusado: ${r.erro || r.detalhe}`)
        return { textoVisivel: textoDeRecusa(r.erro), novoState: state }
      }
      state = { eventId: r.event_id, start, end, nome, email }
      return { textoVisivel, novoState: state }
    } catch (err) {
      console.error('[Agenda Actions] marcarReuniao falhou:', err)
      return { textoVisivel: textoDeRecusa(undefined), novoState: state }
    }
  }

  if (acao.tipo === 'reschedule') {
    if (!state.eventId) {
      return { textoVisivel: textoVisivel + NAO_ACHOU_REUNIAO, novoState: state }
    }
    const start = acao.start || ''
    const end = acao.end || ''
    if (!(start && end)) {
      console.error(`[Agenda Actions] RESCHEDULE sem horário (tel=...${telefone.slice(-4)}), ignorado`)
      return { textoVisivel: MOVER_RECUSADO, novoState: state }
    }
    try {
      const r = await remarcarReuniao({ eventId: state.eventId, telefone, start, end })
      if (!r.ok) {
        console.error(`[Agenda Actions] RESCHEDULE recusado: ${r.erro || r.detalhe}`)
        return { textoVisivel: MOVER_RECUSADO, novoState: state }
      }
      state = { ...state, start, end }
      return { textoVisivel, novoState: state }
    } catch (err) {
      console.error('[Agenda Actions] remarcarReuniao falhou:', err)
      return { textoVisivel: MOVER_RECUSADO, novoState: state }
    }
  }

  if (acao.tipo === 'cancel') {
    if (!state.eventId) {
      return { textoVisivel: textoVisivel + NAO_ACHOU_REUNIAO, novoState: state }
    }
    try {
      const r = await cancelarReuniao({ eventId: state.eventId, telefone })
      if (r.ok) {
        return { textoVisivel, novoState: {} }
      }
      console.error(`[Agenda Actions] CANCEL recusado: ${r.erro || r.detalhe}`)
      return { textoVisivel: textoVisivel + CANCELAR_RECUSADO, novoState: state }
    } catch (err) {
      console.error('[Agenda Actions] cancelarReuniao falhou:', err)
      return { textoVisivel: textoVisivel + CANCELAR_RECUSADO, novoState: state }
    }
  }

  console.error(`[Agenda Actions] tipo de ação desconhecido da ponte: ${(acao as { tipo?: string }).tipo}`)
  return { textoVisivel, novoState: state }
}
