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

import {
  marcarReuniao,
  remarcarReuniao,
  cancelarReuniao,
  buscarSlots,
  type SlotsResultado,
} from '@/lib/agenda-autonomia'
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

export type AgendaActionsDeps = {
  marcarReuniaoFn?: typeof marcarReuniao
  remarcarReuniaoFn?: typeof remarcarReuniao
  cancelarReuniaoFn?: typeof cancelarReuniao
  buscarSlotsFn?: typeof buscarSlots
  now?: () => Date
  beforeExternalEffect?: () => Promise<boolean>
}

export type ResultadoValidacaoSlot = {
  valido: boolean
  motivo?: string
  detalhe?: string
}

const NAO_ACHOU_REUNIAO =
  '\n\nNão encontrei uma reunião marcada pra você aqui, deixa eu confirmar com o time.'

const MOVER_RECUSADO =
  'Opa, não consegui mexer nesse horário agora. Seu horário atual continua de pé. Quer que eu veja outra opção, ou o time confirma com você em instantes?'

const CANCELAR_RECUSADO =
  '\n\nNão consegui cancelar agora, o time confirma com você em instantes.'

/**
 * Converte string ISO ou formato comum em Date com tolerância a fusos.
 * Se vier sem offset, assume horário comercial padrão do Brasil (America/Sao_Paulo, -03:00).
 */
export function parseIsoDate(val?: string | null): Date | null {
  if (!val || typeof val !== 'string') return null
  const s = val.trim()
  if (!s) return null

  // (1) ISO 8601 com offset explícito (Z ou +/-HH:mm)
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = new Date(s.replace(' ', 'T'))
    return isNaN(d.getTime()) ? null : d
  }

  // (2) "yyyy-MM-dd[T ]HH:mm[:ss]" sem timezone: assume America/Sao_Paulo (-03:00)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}-03:00`)
    return isNaN(d.getTime()) ? null : d
  }

  const fallback = new Date(s)
  return isNaN(fallback.getTime()) ? null : fallback
}

/**
 * Validação rigorosa do slot antes de chamar a API real de agendamento:
 * 1. Formato de data válido para start e end.
 * 2. start deve ser estritamente anterior a end.
 * 3. start não pode estar no passado.
 * 4. Consulta a lista oficial de horários livres reais (agenda_tools.py slots / buscarSlots)
 *    para o dia alvo. O horário escrito pela IA DEVE bater com um slot livre real.
 *
 * Se a IA alucinar ou errar o horário (ex: cliente pediu 10:30 e a IA colocou 15:00),
 * a validação REJEITA o agendamento, emite log estruturado para telemetria (sem PII),
 * e impede a criação de eventos errados no Google Calendar.
 */
export async function validarSlotRealLivre(
  opts: {
    start: string
    end: string
    telefone: string
  },
  deps: AgendaActionsDeps = {},
): Promise<ResultadoValidacaoSlot> {
  const telMask = `...${(opts.telefone || '').slice(-4)}`
  const reqStart = parseIsoDate(opts.start)
  const reqEnd = parseIsoDate(opts.end)

  if (!reqStart || !reqEnd) {
    console.warn(
      `[Agenda Actions] [HORARIO_INVALIDO_IA] Formato de data inválido gerado pela IA: start="${opts.start}" end="${opts.end}" (tel=${telMask})`
    )
    return { valido: false, motivo: 'formato_invalido' }
  }

  if (reqStart.getTime() >= reqEnd.getTime()) {
    console.warn(
      `[Agenda Actions] [HORARIO_INVALIDO_IA] Inconsistência de horário gerada pela IA: start="${opts.start}" >= end="${opts.end}" (tel=${telMask})`
    )
    return { valido: false, motivo: 'start_apos_end' }
  }

  const now = deps.now ? deps.now() : new Date()
  if (reqStart.getTime() < now.getTime()) {
    console.warn(
      `[Agenda Actions] [HORARIO_INVALIDO_IA] Horário no passado gerado pela IA: start="${opts.start}" (tel=${telMask})`
    )
    return { valido: false, motivo: 'horario_no_passado' }
  }

  const targetDateStr = reqStart.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  const fetcher = deps.buscarSlotsFn || buscarSlots

  let slotsRes: SlotsResultado
  try {
    slotsRes = await fetcher({ startDate: targetDateStr, days: 3 })
  } catch (err) {
    console.error(
      `[Agenda Actions] Falha ao consultar slots livres reais na API de agenda (data=${targetDateStr}, tel=${telMask}):`,
      err
    )
    return { valido: false, motivo: 'agenda_indisponivel' }
  }

  if (!slotsRes.ok || !Array.isArray(slotsRes.horarios)) {
    console.error(
      `[Agenda Actions] Resposta de erro ao consultar slots livres (data=${targetDateStr}, tel=${telMask}): ${slotsRes.erro || slotsRes.detalhe}`
    )
    return { valido: false, motivo: slotsRes.erro || 'agenda_indisponivel' }
  }

  const match = slotsRes.horarios.some((slot) => {
    const slotStart = parseIsoDate(slot.start)
    const slotEnd = parseIsoDate(slot.end)
    if (!slotStart || !slotEnd) return false
    const diffStart = Math.abs(reqStart.getTime() - slotStart.getTime())
    const diffEnd = Math.abs(reqEnd.getTime() - slotEnd.getTime())
    return diffStart <= 60_000 && diffEnd <= 60_000
  })

  if (!match) {
    console.warn(
      `[Agenda Actions] [HORARIO_INVALIDO_IA] Horário sugerido pela IA fora da grade livre: start="${opts.start}" end="${opts.end}" não consta nos ${slotsRes.horarios.length} slots livres reais da data ${targetDateStr} (tel=${telMask}). Evento NÃO criado.`
    )
    return { valido: false, motivo: 'horario_ocupado' }
  }

  return { valido: true }
}

/**
 * Executa a ação que a ponte detectou (`acao_detectada`) e devolve o texto
 * final (que pode substituir integralmente o `resposta` da ponte, se a ação
 * falhar) e o novo `aiScheduleState` do lead.
 */
export async function executarAcaoDetectada(
  opts: {
    acao: AcaoDetectada
    textoVisivel: string
    telefone: string
    nomeContato: string
    state: AiScheduleState
  },
  deps: AgendaActionsDeps = {},
): Promise<{ textoVisivel: string; novoState: AiScheduleState }> {
  const { acao, telefone, nomeContato } = opts
  let state: AiScheduleState = { ...opts.state }
  const textoVisivel = opts.textoVisivel

  const marcar = deps.marcarReuniaoFn || marcarReuniao
  const remarcar = deps.remarcarReuniaoFn || remarcarReuniao
  const cancelar = deps.cancelarReuniaoFn || cancelarReuniao
  const canAct = async () => !deps.beforeExternalEffect || await deps.beforeExternalEffect()

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

      // Validação: novo horário para remarcar deve estar na lista de slots reais livres
      const validacao = await validarSlotRealLivre({ start, end, telefone }, deps)
      if (!validacao.valido) {
        return { textoVisivel: MOVER_RECUSADO, novoState: state }
      }

      try {
        if (!await canAct()) return { textoVisivel: MOVER_RECUSADO, novoState: state }
        const r = await remarcar({ eventId: state.eventId, telefone, start, end })
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

    // Validação: antes de salvar pendente ou marcar reunião, valida que o horário
    // realmente existe na lista de horários livres da agenda
    const validacao = await validarSlotRealLivre({ start, end, telefone }, deps)
    if (!validacao.valido) {
      // Limpa horários pendentes inválidos para não poluir o state
      const { pendingStart: _ps, pendingEnd: _pe, ...stateLimpo } = state
      const erroCode = validacao.motivo === 'horario_no_passado' ? 'horario_no_passado' : 'horario_ocupado'
      return {
        textoVisivel: textoDeRecusa(erroCode),
        novoState: stateLimpo,
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
      if (!await canAct()) return { textoVisivel: textoDeRecusa(undefined), novoState: state }
      const r = await marcar({
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

    // Se o horário for o mesmo, não faz nada
    if (start === state.start && end === state.end) {
      return { textoVisivel, novoState: state }
    }

    // Validação: novo horário para remarcar deve estar na lista de slots reais livres
    const validacao = await validarSlotRealLivre({ start, end, telefone }, deps)
    if (!validacao.valido) {
      return { textoVisivel: MOVER_RECUSADO, novoState: state }
    }

    try {
      if (!await canAct()) return { textoVisivel: MOVER_RECUSADO, novoState: state }
      const r = await remarcar({ eventId: state.eventId, telefone, start, end })
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
      if (!await canAct()) return { textoVisivel: CANCELAR_RECUSADO, novoState: state }
      const r = await cancelar({ eventId: state.eventId, telefone })
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
