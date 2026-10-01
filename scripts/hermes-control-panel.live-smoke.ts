import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import net from 'node:net'
import { mock } from 'node:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import * as schema from '../src/lib/db/schema'
import {
  legacyAgendaHoursToAvailabilitySchedule,
  type AvailabilitySchedule,
} from '../src/lib/agenda-schedule'
import {
  readHermesAgendaConfig,
  syncHermesAgendaSchedule,
  type LegacyAgendaConfig,
} from '../src/lib/hermes-control-panel'

const CONTAINER = `hermes_agenda_live_smoke_${process.pid}`
const API_KEY = `hermes-agenda-live-smoke-${process.pid}`

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('porta indisponível'))
      server.close(() => resolve(address.port))
    })
  })
}

async function startPostgres(): Promise<{ url: string; stop: () => void }> {
  const port = await freePort()
  execFileSync('docker', [
    'run', '--rm', '-d', '--name', CONTAINER,
    '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=test',
    '-p', `127.0.0.1:${port}:5432`, 'postgres:16-alpine',
  ], { stdio: 'ignore' })
  const url = `postgres://postgres:test@127.0.0.1:${port}/test`
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const ready = spawnSync('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'test'])
    if (ready.status === 0) return {
      url,
      stop: () => { spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' }) },
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('Postgres descartável não ficou pronto')
}

function toSchedule(config: LegacyAgendaConfig): AvailabilitySchedule {
  return legacyAgendaHoursToAvailabilitySchedule({
    timezone: config.timezone,
    slotMinutes: config.slot_minutes,
    hours: config.hours,
  })
}

async function main() {
  assert.equal(process.env.CONFIRM_HERMES_LIVE_SMOKE, 'drlucas', 'Defina CONFIRM_HERMES_LIVE_SMOKE=drlucas.')
  assert.ok(process.env.PAINEL_API_TOKEN, 'PAINEL_API_TOKEN ausente')
  process.env.HERMES_PANEL_URL ||= 'https://hermes.casaldotrafego.com/agente'

  const initial = await readHermesAgendaConfig('drlucas')
  assert.equal(initial.ok, true, initial.ok ? '' : initial.error)
  if (!initial.ok || !initial.data.config) throw new Error('Config original do Hermes ausente')
  const originalConfig = structuredClone(initial.data.config)
  const originalSchedule = toSchedule(originalConfig)
  const temporarySchedule: AvailabilitySchedule = {
    ...originalSchedule,
    // Valor operacionalmente equivalente ao offset atual; horas e slots não mudam.
    timezone: originalSchedule.timezone === '-03:00' ? 'America/Sao_Paulo' : '-03:00',
  }

  let disposable: Awaited<ReturnType<typeof startPostgres>> | null = null
  let sql: ReturnType<typeof postgres> | null = null
  try {
    disposable = await startPostgres()
    process.env.DATABASE_URL = disposable.url
    execFileSync('pnpm', ['exec', 'drizzle-kit', 'push', '--force'], {
      env: process.env,
      stdio: 'ignore',
    })

    sql = postgres(disposable.url)
    const db = drizzle(sql, { schema })
    mock.module('@/lib/db', { namedExports: { db } })
    const [company] = await db.insert(schema.companies).values({
      name: 'Dr. Lucas — smoke isolado',
      slug: 'drlucas',
      inviteToken: API_KEY,
    }).returning()
    mock.module('@/lib/agent-auth', {
      namedExports: {
        authenticateAgentRequest: async () => ({
          error: null,
          context: { company, agentName: 'Smoke', agentId: 'renato' },
        }),
        logAgentActivity: async (params: {
          companyId: number
          agentName: string
          agentId?: string
          action: string
          entityType: string
          details?: Record<string, unknown>
        }) => {
          await db.insert(schema.agentActivityLogs).values({
            companyId: params.companyId,
            agentName: params.agentName,
            agentId: params.agentId,
            action: params.action,
            entityType: params.entityType,
            details: params.details,
          })
        },
      },
    })
    mock.module('@/lib/google-calendar-sync', {
      namedExports: { maybeRefreshGoogleCalendarSync: async () => undefined },
    })

    const route = await import('../src/app/api/v1/companies/[idOrSlug]/agenda/schedule/route')
    const request = new NextRequest('http://isolated.test/api/v1/companies/drlucas/agenda/schedule', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(temporarySchedule),
    })
    const response = await route.PUT(request, { params: Promise.resolve({ idOrSlug: 'drlucas' }) })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.schedule.timezone, temporarySchedule.timezone)

    const [stored] = await db.select().from(schema.settings).where(eq(schema.settings.companyId, company.id))
    assert.deepEqual(stored.availabilitySchedule, temporarySchedule)
    assert.equal(stored.availabilityScheduleManual, true)
    const activity = await db.select().from(schema.agentActivityLogs)
    assert.equal(activity.some(row => row.action === 'agenda_update_schedule'), true)

    const remote = await readHermesAgendaConfig('drlucas')
    if (!remote.ok) throw new Error(remote.error)
    assert.equal(remote.data.config?.timezone, temporarySchedule.timezone)
    assert.equal(remote.data.config?.slot_minutes, originalConfig.slot_minutes)
    assert.deepEqual(remote.data.config?.hours, originalConfig.hours)

    console.log(JSON.stringify({
      ok: true,
      routeStatus: response.status,
      databasePersisted: true,
      auditPersisted: true,
      hermesReadBackConfirmed: true,
      temporaryTimezone: temporarySchedule.timezone,
      hoursUnchanged: true,
      slotMinutesUnchanged: true,
    }))
  } finally {
    const restored = await syncHermesAgendaSchedule('drlucas', originalSchedule)
    if (!restored.ok) throw new Error(restored.error)
    const finalRead = await readHermesAgendaConfig('drlucas')
    if (!finalRead.ok) throw new Error(finalRead.error)
    assert.deepEqual(finalRead.data.config, originalConfig, 'Hermes não voltou ao JSON original')
    console.log(JSON.stringify({ ok: true, exactOriginalRestored: true }))
    if (sql) await sql.end({ timeout: 2 })
    mock.restoreAll()
    disposable?.stop()
  }
}

main().catch(error => {
  console.error(error)
  spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })
  process.exitCode = 1
})
