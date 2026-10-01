import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  availabilityScheduleToLegacyHours,
  shouldSyncHermesAgendaBlockRemoval,
  shouldSyncHermesAgenda,
  syncHermesAgendaBlockDate,
  syncHermesAgendaSchedule,
} from '../src/lib/hermes-control-panel'
import type { AvailabilitySchedule } from '../src/lib/agenda-schedule'

type FetchCall = { url: string; init: RequestInit; body?: Record<string, unknown> }

const schedule: AvailabilitySchedule = {
  segunda: [{ inicio: '08:00', fim: '11:45' }],
  terca: [{ inicio: '08:00', fim: '11:45' }],
  quarta: [{ inicio: '08:00', fim: '11:45' }],
  quinta: [{ inicio: '08:00', fim: '11:45' }],
  sexta: [{ inicio: '08:00', fim: '12:30' }],
  sabado: null,
  domingo: null,
  timezone: '-03:00',
  duracaoSlotMinutos: 15,
}

const originalEnv = { ...process.env }
const originalFetch = global.fetch

function restore() {
  process.env = { ...originalEnv }
  global.fetch = originalFetch
}

test('converte agenda do SAC para hours 0..6 consumido pelo agenda_tools.py', () => {
  assert.deepEqual(availabilityScheduleToLegacyHours(schedule), {
    '0': [],
    '1': [['08:00', '11:45']],
    '2': [['08:00', '11:45']],
    '3': [['08:00', '11:45']],
    '4': [['08:00', '11:45']],
    '5': [['08:00', '12:30']],
    '6': [],
  })
})

test('só Dr. Lucas sincroniza agenda com a control API do Hermes', () => {
  assert.equal(shouldSyncHermesAgenda('drlucas'), true)
  assert.equal(shouldSyncHermesAgenda('gramado-plaza'), false)
  assert.equal(shouldSyncHermesAgenda('autonomia'), false)
})

test('desbloqueio no Hermes só roda para bloqueio manual ou fonte do bot', () => {
  assert.equal(shouldSyncHermesAgendaBlockRemoval('drlucas', 'manual'), true)
  assert.equal(shouldSyncHermesAgendaBlockRemoval('drlucas', 'bot_bloqueios'), true)
  assert.equal(shouldSyncHermesAgendaBlockRemoval('drlucas', 'google_calendar+bot_bloqueios'), true)
  assert.equal(shouldSyncHermesAgendaBlockRemoval('drlucas', 'google_calendar'), false)
  assert.equal(shouldSyncHermesAgendaBlockRemoval('gramado-plaza', 'manual'), false)
})

test('sync de horário preserva campos existentes do agenda_config.json e sobrescreve só a grade', async () => {
  restore()
  process.env.PAINEL_API_TOKEN = 'token-teste'
  process.env.HERMES_PANEL_URL = 'https://hermes.example/agente/'
  const calls: FetchCall[] = []
  global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ url: String(url), init: init || {}, body })
    if (String(url).includes('/api/agenda-config?')) {
      return Response.json({
        config: {
          timezone: '-03:00',
          slot_minutes: 30,
          hours: { '1': [['09:00', '10:00']] },
          webhook: { enabled: true, url_agenda: 'https://crm.example/agenda' },
          antecedencia_min: 60,
        },
      })
    }
    return Response.json({ ok: true, config: body.config })
  }) as typeof fetch

  try {
    const result = await syncHermesAgendaSchedule('drlucas', schedule)
    assert.equal(result.ok, true)
    assert.equal(calls.length, 2)
    const getCall = calls[0]
    const postCall = calls[1]
    assert.ok(getCall)
    assert.ok(postCall)
    assert.equal(getCall.url, 'https://hermes.example/agente/api/agenda-config?agente=drlucas')
    assert.equal(postCall.url, 'https://hermes.example/agente/api/agenda-config')
    assert.equal(postCall.init.method, 'POST')
    assert.equal((postCall.init.headers as Record<string, string>).authorization, 'Bearer token-teste')
    const postedBody = postCall.body as {
      agente?: string
      config?: {
        slot_minutes?: number
        hours?: Record<string, string[][]>
        webhook?: Record<string, unknown>
        antecedencia_min?: number
      }
    } | undefined
    assert.ok(postedBody?.config)
    assert.equal(postedBody.agente, 'drlucas')
    assert.equal(postedBody.config.slot_minutes, 15)
    assert.deepEqual(postedBody.config.hours?.['5'], [['08:00', '12:30']])
    assert.deepEqual(postedBody.config.webhook, { enabled: true, url_agenda: 'https://crm.example/agenda' })
    assert.equal(postedBody.config.antecedencia_min, 60)
  } finally {
    restore()
  }
})

test('sync de bloqueio usa os endpoints antigos que escrevem bloqueios.json', async () => {
  restore()
  process.env.PAINEL_API_TOKEN = 'token-teste'
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = []
  global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    return Response.json({ ok: true })
  }) as typeof fetch

  try {
    const block = await syncHermesAgendaBlockDate('drlucas', '2026-10-12', 'Viagem', true)
    const unblock = await syncHermesAgendaBlockDate('drlucas', '2026-10-12', '', false)
    assert.equal(block.ok, true)
    assert.equal(unblock.ok, true)
    assert.equal(calls[0].url, 'https://hermes.casaldotrafego.com/agente/api/agenda-bloquear')
    assert.deepEqual(calls[0].body, { agente: 'drlucas', data: '2026-10-12', motivo: 'Viagem' })
    assert.equal(calls[1].url, 'https://hermes.casaldotrafego.com/agente/api/agenda-desbloquear')
    assert.deepEqual(calls[1].body, { agente: 'drlucas', data: '2026-10-12' })
  } finally {
    restore()
  }
})
