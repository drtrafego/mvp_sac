// Parse e execução dos marcadores de agendamento que o SOUL da Nina já sabe
// emitir (<<BOOK ...>>, <<RESCHEDULE ...>>, <<CANCEL>>), portados de
// processar_resposta() em receiver.py. O modelo nunca sabe o id do evento:
// quem guarda isso é o `aiScheduleState` do lead (equivalente ao state.json
// por lead que o receiver.py mantém em disco).
//
// Trava central: NUNCA deixar a fala do modelo anunciar um agendamento que
// não aconteceu de verdade. Falha ou recusa da API de agenda troca a
// resposta inteira por uma frase de handoff, nunca deixa "fechado!" passar.

import {
  buscarSlots,
  marcarReuniao,
  remarcarReuniao,
  cancelarReuniao,
} from '@/lib/agenda-autonomia'
import { pareceFechamento, textoDeRecusa, textoPedeDados } from './security-filters'

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

const BOOK_RE = /<<BOOK\b([^>]*)>>/
const RESCHEDULE_RE = /<<RESCHEDULE start="([^"]*)" end="([^"]*)">>/
const CANCEL_RE = /<<CANCEL>>/

function atributosBook(bruto: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /(\w+)\s*=\s*"([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(bruto))) {
    out[m[1].toLowerCase()] = m[2].trim()
  }
  return out
}

const NAO_ACHOU_REUNIAO =
  '\n\nNão encontrei uma reunião marcada pra você aqui, deixa eu confirmar com o time.'

const MOVER_RECUSADO =
  'Opa, não consegui mexer nesse horário agora. Seu horário atual continua de pé. Quer que eu veja outra opção, ou o time confirma com você em instantes?'

/** Formata os horários livres reais no texto que vai pro contexto do modelo.
 * Bloco vazio ou com erro é INTENCIONAL: o próprio SOUL já instrui a Nina a
 * não ofertar horário nenhum quando isso acontece (seção 9.1). */
export async function formatarSlotsParaPrompt(): Promise<string> {
  try {
    const resultado = await buscarSlots({ days: 4 }, 'sac')
    if (!resultado.ok || !resultado.horarios || resultado.horarios.length === 0) {
      return '(nenhum horário livre retornado agora)'
    }
    const fmt = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    return resultado.horarios
      .map((h) => {
        const partes = fmt.formatToParts(new Date(h.start))
        const get = (t: string) => partes.find((p) => p.type === t)?.value ?? ''
        return `- ${get('weekday')}, ${get('day')}/${get('month')} às ${get('hour')}:${get('minute')} (start="${h.start}" end="${h.end}")`
      })
      .join('\n')
  } catch (err) {
    console.error('[Agenda Autonomia] buscarSlots falhou:', err)
    return '(agenda indisponível agora, erro ao consultar a API)'
  }
}

export async function processarMarcadores(opts: {
  textoBruto: string
  telefone: string
  nomeContato: string
  state: AiScheduleState
}): Promise<{ textoVisivel: string; novoState: AiScheduleState }> {
  const { textoBruto, telefone, nomeContato } = opts
  let state: AiScheduleState = { ...opts.state }
  let textoVisivel = textoBruto

  const bookMatch = BOOK_RE.exec(textoBruto)
  if (bookMatch) {
    textoVisivel = textoVisivel.replace(bookMatch[0], '').trim()
    const attrs = atributosBook(bookMatch[1])
    const nome = attrs.nome || ''
    const email = attrs.email || ''
    let start = attrs.start || ''
    let end = attrs.end || ''

    // o e-mail chegou mas o modelo esqueceu de repetir o horário: usa o
    // pendente guardado na rodada anterior.
    if (!(start && end) && email && state.pendingStart && state.pendingEnd) {
      start = state.pendingStart
      end = state.pendingEnd
    }

    if (!(start && end)) {
      console.error(`[AI Scheduling] BOOK sem horário e sem pendente, ignorado (tel=${telefone.slice(-4)})`)
      return { textoVisivel, novoState: state }
    }

    if (state.eventId) {
      // já existe reunião: só mexe se o horário realmente mudou.
      const mudouHorario = start !== state.start || end !== state.end
      if (!mudouHorario) return { textoVisivel, novoState: state }
      try {
        const r = await remarcarReuniao({ eventId: state.eventId, telefone, start, end })
        if (!r.ok) {
          console.error(`[AI Scheduling] remarcar (via BOOK) recusado: ${r.erro || r.detalhe}`)
          return { textoVisivel: MOVER_RECUSADO, novoState: state }
        }
        state = { ...state, start, end }
        return { textoVisivel, novoState: state }
      } catch (err) {
        console.error('[Agenda Autonomia] remarcarReuniao (via BOOK) falhou:', err)
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
        console.error(`[AI Scheduling] BOOK recusado: ${r.erro || r.detalhe}`)
        return { textoVisivel: textoDeRecusa(r.erro), novoState: state }
      }
      state = { eventId: r.event_id, start, end, nome, email }
      return { textoVisivel, novoState: state }
    } catch (err) {
      console.error('[Agenda Autonomia] marcarReuniao falhou:', err)
      return { textoVisivel: textoDeRecusa(undefined), novoState: state }
    }
  }

  const rescheduleMatch = RESCHEDULE_RE.exec(textoBruto)
  if (rescheduleMatch) {
    textoVisivel = textoVisivel.replace(rescheduleMatch[0], '').trim()
    const [, start, end] = rescheduleMatch
    if (!state.eventId) {
      return { textoVisivel: textoVisivel + NAO_ACHOU_REUNIAO, novoState: state }
    }
    try {
      const r = await remarcarReuniao({ eventId: state.eventId, telefone, start, end })
      if (!r.ok) {
        console.error(`[AI Scheduling] RESCHEDULE recusado: ${r.erro || r.detalhe}`)
        return { textoVisivel: MOVER_RECUSADO, novoState: state }
      }
      state = { ...state, start, end }
      return { textoVisivel, novoState: state }
    } catch (err) {
      console.error('[Agenda Autonomia] remarcarReuniao falhou:', err)
      return { textoVisivel: MOVER_RECUSADO, novoState: state }
    }
  }

  if (CANCEL_RE.test(textoBruto)) {
    textoVisivel = textoVisivel.replace(CANCEL_RE, '').trim()
    if (!state.eventId) {
      return { textoVisivel: textoVisivel + NAO_ACHOU_REUNIAO, novoState: state }
    }
    try {
      const r = await cancelarReuniao({ eventId: state.eventId, telefone })
      if (r.ok) {
        return { textoVisivel: textoVisivel + '\n\n(cancelado de verdade na agenda)', novoState: {} }
      }
      console.error(`[AI Scheduling] CANCEL recusado: ${r.erro || r.detalhe}`)
      return {
        textoVisivel: textoVisivel + '\n\nNão consegui cancelar agora, o time confirma com você em instantes.',
        novoState: state,
      }
    } catch (err) {
      console.error('[Agenda Autonomia] cancelarReuniao falhou:', err)
      return {
        textoVisivel: textoVisivel + '\n\nNão consegui cancelar agora, o time confirma com você em instantes.',
        novoState: state,
      }
    }
  }

  return { textoVisivel, novoState: state }
}
