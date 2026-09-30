import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateDispatchWindow, firstDueJobPerLead, retryAtAfterPreviousFollowupStep, shouldApplyFollowupDispatchWindow } from '../src/lib/followup-dispatch-policy'
import { DEFAULT_AVAILABILITY_SCHEDULE, legacyAgendaHoursToAvailabilitySchedule, type AvailabilitySchedule } from '../src/lib/agenda-schedule'

const BASE_SCHEDULE: AvailabilitySchedule = {
  segunda: [{ inicio: '08:00', fim: '18:00' }],
  terca: [{ inicio: '08:00', fim: '18:00' }],
  quarta: null,
  quinta: null,
  sexta: null,
  sabado: null,
  domingo: null,
  timezone: 'America/Sao_Paulo',
  duracaoSlotMinutos: 30,
}

test('converte a grade legada do mvp_agente_ia para o formato do SAC', () => {
  const schedule = legacyAgendaHoursToAvailabilitySchedule({
    timezone: '-03:00',
    slotMinutes: 20,
    hours: {
      '0': [],
      '1': [['08:00', '12:00'], ['14:00', '18:00']],
      '2': [['09:00', '11:00']],
      '3': [],
      '4': [],
      '5': [],
      '6': [],
    },
  })

  assert.deepEqual(schedule.segunda, [{ inicio: '08:00', fim: '12:00' }, { inicio: '14:00', fim: '18:00' }])
  assert.deepEqual(schedule.terca, [{ inicio: '09:00', fim: '11:00' }])
  assert.equal(schedule.domingo, null)
  assert.equal(schedule.duracaoSlotMinutos, 20)
})

test('default da agenda replica o painel antigo: segunda a sexta 08h-12h', () => {
  assert.deepEqual(DEFAULT_AVAILABILITY_SCHEDULE.segunda, [{ inicio: '08:00', fim: '12:00' }])
  assert.deepEqual(DEFAULT_AVAILABILITY_SCHEDULE.quinta, [{ inicio: '08:00', fim: '12:00' }])
  assert.equal(DEFAULT_AVAILABILITY_SCHEDULE.sabado, null)
  assert.equal(DEFAULT_AVAILABILITY_SCHEDULE.domingo, null)
})

test('slot legado inválido cai para 30 sem descartar a grade', () => {
  const schedule = legacyAgendaHoursToAvailabilitySchedule({
    timezone: '-03:00',
    slotMinutes: 5,
    hours: {
      '1': [['10:00', '11:00']],
    },
  })

  assert.deepEqual(schedule.segunda, [{ inicio: '10:00', fim: '11:00' }])
  assert.equal(schedule.duracaoSlotMinutos, 30)
})

test('permite follow-up dentro do horário da empresa', () => {
  const decision = evaluateDispatchWindow({
    schedule: BASE_SCHEDULE,
    now: new Date('2026-09-28T13:00:00.000Z'), // segunda 10:00 em Sao Paulo
  })

  assert.deepEqual(decision, { allowed: true })
})

test('adia follow-up fora do horário para a próxima faixa da própria empresa', () => {
  const decision = evaluateDispatchWindow({
    schedule: BASE_SCHEDULE,
    now: new Date('2026-09-28T23:00:00.000Z'), // segunda 20:00 em Sao Paulo
  })

  assert.equal(decision.allowed, false)
  assert.equal(decision.retryAt?.toISOString(), '2026-09-29T11:00:00.000Z')
})

test('aceita fuso legado em offset -03:00 vindo do mvp_agente_ia', () => {
  const decision = evaluateDispatchWindow({
    schedule: { ...BASE_SCHEDULE, timezone: '-03:00' },
    now: new Date('2026-09-28T13:00:00.000Z'),
  })

  assert.deepEqual(decision, { allowed: true })
})

test('respeita bloqueio de data antes de enviar follow-up', () => {
  const decision = evaluateDispatchWindow({
    schedule: BASE_SCHEDULE,
    blockedDates: ['2026-09-29'],
    now: new Date('2026-09-28T23:00:00.000Z'),
  })

  assert.equal(decision.allowed, false)
  assert.equal(decision.retryAt?.toISOString(), '2026-10-05T11:00:00.000Z')
})

test('cada agente usa sua própria grade, sem vazar configuração entre empresas', () => {
  const scheduleA = BASE_SCHEDULE
  const scheduleB: AvailabilitySchedule = {
    ...BASE_SCHEDULE,
    segunda: [{ inicio: '14:00', fim: '18:00' }],
  }
  const now = new Date('2026-09-28T13:00:00.000Z')

  assert.equal(evaluateDispatchWindow({ schedule: scheduleA, now }).allowed, true)
  const decisionB = evaluateDispatchWindow({ schedule: scheduleB, now })
  assert.equal(decisionB.allowed, false)
  assert.equal(decisionB.retryAt?.toISOString(), '2026-09-28T17:00:00.000Z')
})

test('quando vários passos vencem juntos, só o primeiro fica para envio', () => {
  const selected = firstDueJobPerLead([
    { id: 10, leadId: 1, messageOrder: 1 },
    { id: 11, leadId: 1, messageOrder: 2 },
    { id: 12, leadId: 2, messageOrder: 1 },
  ])

  assert.deepEqual(selected.keep.map(job => job.id).sort(), [10, 12])
  assert.deepEqual(selected.defer.map(job => job.id), [11])
})

test('política de horário só se aplica a follow-up, não a disparo em massa', () => {
  assert.equal(shouldApplyFollowupDispatchWindow({ messageOrder: 1, massDispatchBatchId: null }), true)
  assert.equal(shouldApplyFollowupDispatchWindow({ upsellContent: 'texto', massDispatchBatchId: null }), true)
  assert.equal(shouldApplyFollowupDispatchWindow({ messageOrder: 1, massDispatchBatchId: 99 }), false)
  assert.equal(shouldApplyFollowupDispatchWindow({ messageOrder: null, massDispatchBatchId: null }), false)
})

test('passo atrasado respeita o espaçamento desde o follow-up anterior enviado', () => {
  const retryAt = retryAtAfterPreviousFollowupStep({
    previousSentAt: new Date('2026-09-28T13:00:00.000Z'),
    previousDelayMinutes: 30,
    currentDelayMinutes: 120,
    now: new Date('2026-09-28T13:05:00.000Z'),
  })

  assert.equal(retryAt?.toISOString(), '2026-09-28T14:30:00.000Z')
  assert.equal(retryAtAfterPreviousFollowupStep({
    previousSentAt: new Date('2026-09-28T13:00:00.000Z'),
    previousDelayMinutes: 30,
    currentDelayMinutes: 120,
    now: new Date('2026-09-28T14:31:00.000Z'),
  }), null)
})
