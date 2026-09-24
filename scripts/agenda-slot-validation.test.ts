import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseIsoDate,
  validarSlotRealLivre,
  executarAcaoDetectada,
  type AiScheduleState,
} from '../src/lib/ai/agenda-actions'
import type { SlotsResultado, Horario } from '../src/lib/agenda-autonomia'
import type { AcaoDetectada } from '../src/lib/ai/ai-bridge'
import { textoDeRecusa } from '../src/lib/ai/security-filters'

test('parseIsoDate: analisa formatos com e sem timezone corretamente', () => {
  // ISO com offset explícito
  const d1 = parseIsoDate('2026-09-25T10:30:00-03:00')
  assert.ok(d1 !== null)
  assert.equal(d1.toISOString(), '2026-09-25T13:30:00.000Z')

  // ISO com Z
  const d2 = parseIsoDate('2026-09-25T13:30:00Z')
  assert.ok(d2 !== null)
  assert.equal(d2.toISOString(), '2026-09-25T13:30:00.000Z')

  // Sem offset: deve assumir America/Sao_Paulo (-03:00)
  const d3 = parseIsoDate('2026-09-25T10:30:00')
  assert.ok(d3 !== null)
  assert.equal(d3.toISOString(), '2026-09-25T13:30:00.000Z')

  // Com espaço em vez de T e sem segundos
  const d4 = parseIsoDate('2026-09-25 10:30')
  assert.ok(d4 !== null)
  assert.equal(d4.toISOString(), '2026-09-25T13:30:00.000Z')

  // Inválidos
  assert.equal(parseIsoDate(''), null)
  assert.equal(parseIsoDate(null), null)
  assert.equal(parseIsoDate('amanhã 10h'), null)
})

test('validarSlotRealLivre: rejeita horários no passado, inválidos ou inconsistentes', async () => {
  const fakeNow = new Date('2026-09-25T09:00:00-03:00')

  // Formato inválido
  const rInvalido = await validarSlotRealLivre(
    { start: 'data-errada', end: '2026-09-25T11:00:00-03:00', telefone: '5511999998888' },
    { now: () => fakeNow }
  )
  assert.equal(rInvalido.valido, false)
  assert.equal(rInvalido.motivo, 'formato_invalido')

  // start >= end
  const rInvertido = await validarSlotRealLivre(
    {
      start: '2026-09-25T11:00:00-03:00',
      end: '2026-09-25T10:30:00-03:00',
      telefone: '5511999998888',
    },
    { now: () => fakeNow }
  )
  assert.equal(rInvertido.valido, false)
  assert.equal(rInvertido.motivo, 'start_apos_end')

  // Horário no passado
  const rPassado = await validarSlotRealLivre(
    {
      start: '2026-09-25T08:00:00-03:00',
      end: '2026-09-25T08:30:00-03:00',
      telefone: '5511999998888',
    },
    { now: () => fakeNow }
  )
  assert.equal(rPassado.valido, false)
  assert.equal(rPassado.motivo, 'horario_no_passado')
})

test('validarSlotRealLivre: valida contra a lista de slots reais da API e rejeita alucinação da IA', async () => {
  const fakeNow = new Date('2026-09-25T09:00:00-03:00')

  const slotsLivresReais: Horario[] = [
    { start: '2026-09-25T10:30:00-03:00', end: '2026-09-25T11:00:00-03:00' },
    { start: '2026-09-25T11:30:00-03:00', end: '2026-09-25T12:00:00-03:00' },
    { start: '2026-09-25T14:00:00-03:00', end: '2026-09-25T14:30:00-03:00' },
  ]

  const mockBuscarSlots = async (opts: { startDate?: string; days?: number }): Promise<SlotsResultado> => {
    return { ok: true, horarios: slotsLivresReais }
  }

  // 1. Caso de sucesso: IA escolheu um slot que existe de verdade na lista (10:30)
  const rSucesso = await validarSlotRealLivre(
    {
      start: '2026-09-25T10:30:00-03:00',
      end: '2026-09-25T11:00:00-03:00',
      telefone: '5511999998888',
    },
    { buscarSlotsFn: mockBuscarSlots as any, now: () => fakeNow }
  )
  assert.equal(rSucesso.valido, true)

  // 2. CASO REAL DO BUG (Gastão): cliente pediu 10:30, mas IA inventou 15:00
  // 15:00 NÃO está em slotsLivresReais -> DEVE ser recusado!
  const rAlucinacao = await validarSlotRealLivre(
    {
      start: '2026-09-25T15:00:00-03:00',
      end: '2026-09-25T15:30:00-03:00',
      telefone: '5511999998888',
    },
    { buscarSlotsFn: mockBuscarSlots as any, now: () => fakeNow }
  )
  assert.equal(rAlucinacao.valido, false)
  assert.equal(rAlucinacao.motivo, 'horario_ocupado')
})

test('executarAcaoDetectada: bloqueia agendamento real quando a IA alucina horário (15:00 em vez de 10:30)', async () => {
  const fakeNow = new Date('2026-09-25T09:00:00-03:00')
  let marcouChamada = false

  const mockBuscarSlots = async (): Promise<SlotsResultado> => {
    return {
      ok: true,
      horarios: [
        { start: '2026-09-25T10:30:00-03:00', end: '2026-09-25T11:00:00-03:00' },
      ],
    }
  }

  const mockMarcarReuniao = async (): Promise<any> => {
    marcouChamada = true
    return { ok: true, event_id: 'evento_123' }
  }

  const acaoAlucinada: AcaoDetectada = {
    tipo: 'book',
    nome: 'Cliente Teste',
    email: 'cliente@teste.com',
    start: '2026-09-25T15:00:00-03:00', // Horário alucinado fora dos slots livres
    end: '2026-09-25T15:30:00-03:00',
  }

  const logsCapturados: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: any[]) => {
    logsCapturados.push(args.join(' '))
    originalWarn(...args)
  }

  try {
    const res = await executarAcaoDetectada(
      {
        acao: acaoAlucinada,
        textoVisivel: 'Perfeito! Reunião marcada para amanhã às 15:00!',
        telefone: '5511999998888',
        nomeContato: 'Cliente Teste',
        state: {},
      },
      {
        buscarSlotsFn: mockBuscarSlots as any,
        marcarReuniaoFn: mockMarcarReuniao as any,
        now: () => fakeNow,
      }
    )

    // 1. marcarReuniao NUNCA deve ser chamada
    assert.equal(marcouChamada, false)

    // 2. Não cria evento no state
    assert.equal(res.novoState.eventId, undefined)

    // 3. Texto visível é substituído pela recusa amigável
    assert.equal(
      res.textoVisivel,
      textoDeRecusa('horario_ocupado')
    )

    // 4. Log emitido contém tag estruturada e telefone mascarado (sem dados pessoais)
    const logAlucinacao = logsCapturados.find((l) => l.includes('[HORARIO_INVALIDO_IA]'))
    assert.ok(logAlucinacao !== undefined, 'Deve emitir log com tag [HORARIO_INVALIDO_IA]')
    assert.ok(logAlucinacao.includes('tel=...8888'), 'Telefone deve estar mascarado')
    assert.ok(!logAlucinacao.includes('5511999998888'), 'Não pode vazar telefone completo')
    assert.ok(!logAlucinacao.includes('cliente@teste.com'), 'Não pode vazar email')
  } finally {
    console.warn = originalWarn
  }
})

test('executarAcaoDetectada: realiza agendamento com sucesso quando horário bate com a lista de slots reais', async () => {
  const fakeNow = new Date('2026-09-25T09:00:00-03:00')
  let dadosChamada: any = null

  const mockBuscarSlots = async (): Promise<SlotsResultado> => {
    return {
      ok: true,
      horarios: [
        { start: '2026-09-25T10:30:00-03:00', end: '2026-09-25T11:00:00-03:00' },
      ],
    }
  }

  const mockMarcarReuniao = async (dados: any): Promise<any> => {
    dadosChamada = dados
    return { ok: true, event_id: 'evento_real_999' }
  }

  const acaoValida: AcaoDetectada = {
    tipo: 'book',
    nome: 'Cliente Teste',
    email: 'cliente@teste.com',
    start: '2026-09-25T10:30:00-03:00',
    end: '2026-09-25T11:00:00-03:00',
  }

  const res = await executarAcaoDetectada(
    {
      acao: acaoValida,
      textoVisivel: 'Reunião marcada para amanhã às 10:30!',
      telefone: '5511999998888',
      nomeContato: 'Cliente Teste',
      state: {},
    },
    {
      buscarSlotsFn: mockBuscarSlots as any,
      marcarReuniaoFn: mockMarcarReuniao as any,
      now: () => fakeNow,
    }
  )

  assert.ok(dadosChamada !== null)
  assert.equal(dadosChamada.start, '2026-09-25T10:30:00-03:00')
  assert.equal(dadosChamada.end, '2026-09-25T11:00:00-03:00')
  assert.equal(dadosChamada.email, 'cliente@teste.com')
  assert.equal(res.novoState.eventId, 'evento_real_999')
  assert.equal(res.textoVisivel, 'Reunião marcada para amanhã às 10:30!')
})

test('executarAcaoDetectada: impede remarcação (reschedule) para horário fora dos slots livres', async () => {
  const fakeNow = new Date('2026-09-25T09:00:00-03:00')
  let remarcou = false

  const mockBuscarSlots = async (): Promise<SlotsResultado> => {
    return {
      ok: true,
      horarios: [
        { start: '2026-09-25T10:30:00-03:00', end: '2026-09-25T11:00:00-03:00' },
      ],
    }
  }

  const mockRemarcarReuniao = async (): Promise<any> => {
    remarcou = true
    return { ok: true, event_id: 'evento_existente' }
  }

  const estadoExistente: AiScheduleState = {
    eventId: 'evento_existente',
    start: '2026-09-25T10:30:00-03:00',
    end: '2026-09-25T11:00:00-03:00',
    nome: 'Cliente',
    email: 'c@teste.com',
  }

  // Tenta remarcar para 17:00 (não existe em slots)
  const acaoRescheduleInvalida: AcaoDetectada = {
    tipo: 'reschedule',
    start: '2026-09-25T17:00:00-03:00',
    end: '2026-09-25T17:30:00-03:00',
  }

  const res = await executarAcaoDetectada(
    {
      acao: acaoRescheduleInvalida,
      textoVisivel: 'Remarcado para às 17:00!',
      telefone: '5511999998888',
      nomeContato: 'Cliente',
      state: estadoExistente,
    },
    {
      buscarSlotsFn: mockBuscarSlots as any,
      remarcarReuniaoFn: mockRemarcarReuniao as any,
      now: () => fakeNow,
    }
  )

  // Não deve remarcar na API real
  assert.equal(remarcou, false)
  // Estado permanece inalterado
  assert.equal(res.novoState.start, '2026-09-25T10:30:00-03:00')
  // Retorna texto de recusa de mover
  assert.ok(res.textoVisivel.includes('não consegui mexer nesse horário agora'))
})
