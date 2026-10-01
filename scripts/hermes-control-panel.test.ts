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
  let storedConfig: Record<string, unknown> = {
    timezone: '-03:00',
    slot_minutes: 30,
    hours: { '1': [['09:00', '10:00']] },
    webhook: { enabled: true, url_agenda: 'https://crm.example/agenda' },
    antecedencia_min: 60,
  }
  global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ url: String(url), init: init || {}, body })
    if (String(url).includes('/api/agenda-config?')) {
      return Response.json({ config: storedConfig })
    }
    storedConfig = body.config
    return Response.json({ ok: true, config: storedConfig })
  }) as typeof fetch

  try {
    const result = await syncHermesAgendaSchedule('drlucas', schedule)
    assert.equal(result.ok, true)
    assert.equal(calls.length, 3)
    assert.equal(calls[0].url, 'https://hermes.example/agente/api/agenda-config?agente=drlucas')
    assert.equal(calls[1].url, 'https://hermes.example/agente/api/agenda-config')
    assert.equal(calls[2].url, 'https://hermes.example/agente/api/agenda-config?agente=drlucas')
    assert.equal(calls[1].init.method, 'POST')
    assert.equal((calls[1].init.headers as Record<string, string>).authorization, 'Bearer token-teste')
    const writeBody = calls[1].body as { agente: string; config: Record<string, unknown> }
    assert.equal(writeBody.agente, 'drlucas')
    assert.equal(writeBody.config.slot_minutes, 15)
    assert.deepEqual((writeBody.config.hours as Record<string, unknown>)['5'], [['08:00', '12:30']])
    assert.deepEqual(writeBody.config.webhook, { enabled: true, url_agenda: 'https://crm.example/agenda' })
    assert.equal(writeBody.config.antecedencia_min, 60)
  } finally {
    restore()
  }
})

test('sync falha e restaura a configuração anterior quando a releitura não confirma', async () => {
  restore()
  process.env.PAINEL_API_TOKEN = 'token-teste'
  process.env.HERMES_PANEL_URL = 'https://hermes.example/agente'
  const originalConfig = {
    timezone: '-03:00',
    slot_minutes: 30,
    hours: { '1': [['09:00', '10:00']] as [string, string][] },
    webhook: { enabled: false, url: '' },
  }
  const posted: Array<Record<string, unknown>> = []
  let reads = 0
  global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/api/agenda-config?')) {
      reads += 1
      return Response.json({ config: reads === 2 ? { ...originalConfig, timezone: 'UTC' } : originalConfig })
    }
    const body = JSON.parse(String(init?.body))
    posted.push(body.config)
    return Response.json({ ok: true, config: body.config })
  }) as typeof fetch

  try {
    const result = await syncHermesAgendaSchedule('drlucas', schedule)
    assert.equal(result.ok, false)
    assert.equal(posted.length, 2, 'segundo POST restaura o config anterior')
    assert.deepEqual(posted[1], originalConfig)
  } finally {
    restore()
  }
})

test('sync de bloqueio usa os endpoints antigos que escrevem bloqueios.json', async () => {
  restore()
  process.env.PAINEL_API_TOKEN = 'token-teste'
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = []
  const bloqueios: Record<string, string> = {}
  global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ url: String(url), body })
    if (String(url).includes('/api/agenda-bloqueios?')) {
      return Response.json({ bloqueios })
    }
    if (String(url).endsWith('/api/agenda-bloquear')) {
      bloqueios[String(body.data)] = String(body.motivo)
    } else if (String(url).endsWith('/api/agenda-desbloquear')) {
      delete bloqueios[String(body.data)]
    }
    return Response.json({ ok: true })
  }) as typeof fetch

  try {
    const block = await syncHermesAgendaBlockDate('drlucas', '2026-10-12', 'Viagem', true)
    const unblock = await syncHermesAgendaBlockDate('drlucas', '2026-10-12', '', false)
    assert.equal(block.ok, true)
    assert.equal(unblock.ok, true)
    assert.equal(calls.length, 6)
    assert.equal(calls[0].url, 'https://hermes.casaldotrafego.com/agente/api/agenda-bloqueios?agente=drlucas')
    assert.equal(calls[1].url, 'https://hermes.casaldotrafego.com/agente/api/agenda-bloquear')
    assert.deepEqual(calls[1].body, { agente: 'drlucas', data: '2026-10-12', motivo: 'Viagem' })
    assert.equal(calls[2].url, 'https://hermes.casaldotrafego.com/agente/api/agenda-bloqueios?agente=drlucas')
    assert.equal(calls[4].url, 'https://hermes.casaldotrafego.com/agente/api/agenda-desbloquear')
    assert.deepEqual(calls[4].body, { agente: 'drlucas', data: '2026-10-12' })
    assert.deepEqual(bloqueios, {})
    if (!block.ok || !unblock.ok) throw new Error('resultado inesperado')
    assert.equal(block.data.previousReason, null)
    assert.equal(unblock.data.previousReason, 'Viagem')
  } finally {
    restore()
  }
})

test('sync de bloqueio restaura o estado anterior quando a releitura não confirma', async () => {
  restore()
  process.env.PAINEL_API_TOKEN = 'token-teste'
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = []
  let bloqueios: Record<string, string> = { '2026-10-12': 'Motivo anterior' }
  let ignorarPrimeiraEscrita = true
  global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ url: String(url), body })
    if (String(url).includes('/api/agenda-bloqueios?')) {
      return Response.json({ bloqueios })
    }
    if (String(url).endsWith('/api/agenda-bloquear')) {
      if (ignorarPrimeiraEscrita) {
        ignorarPrimeiraEscrita = false
      } else {
        bloqueios = { ...bloqueios, [String(body.data)]: String(body.motivo) }
      }
    }
    return Response.json({ ok: true })
  }) as typeof fetch

  try {
    const result = await syncHermesAgendaBlockDate('drlucas', '2026-10-12', 'Motivo novo', true)
    assert.equal(result.ok, false)
    assert.equal(calls.length, 5)
    assert.deepEqual(calls[3].body, {
      agente: 'drlucas',
      data: '2026-10-12',
      motivo: 'Motivo anterior',
    })
    assert.equal(bloqueios['2026-10-12'], 'Motivo anterior')
  } finally {
    restore()
  }
})
