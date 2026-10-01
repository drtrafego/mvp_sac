import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import net from 'node:net'
import { mock } from 'node:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import * as schema from '../src/lib/db/schema'
import {
  readHermesAgendaBlockedDates,
  restoreHermesAgendaBlockDate,
} from '../src/lib/hermes-control-panel'

const CONTAINER = `hermes_block_live_smoke_${process.pid}`
const API_KEY = `hermes-block-live-smoke-${process.pid}`
const REASON = `Smoke SAC isolado ${process.pid}`
const CANDIDATE_DATES = ['2099-12-31', '2099-12-30', '2099-12-29']

function probeBotBlock(date: string): { blocked: boolean; reason: string } {
  const code = [
    'import importlib.util,json,sys',
    'p="/opt/data/agenda_tools.py"',
    's=importlib.util.spec_from_file_location("agenda_tools_live_probe",p)',
    'm=importlib.util.module_from_spec(s)',
    's.loader.exec_module(m)',
    'd=sys.argv[1]',
    'print(json.dumps({"blocked":m.eh_bloqueado(d),"reason":m.motivo_bloqueio(d)}))',
  ].join(';')
  const raw = execFileSync('docker', ['exec', 'hermes2_drlucas', 'python3', '-c', code, date], {
    encoding: 'utf8',
  })
  return JSON.parse(raw) as { blocked: boolean; reason: string }
}

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
    if (ready.status === 0) {
      return {
        url,
        stop: () => { spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' }) },
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('Postgres descartável não ficou pronto')
}

async function main() {
  assert.equal(process.env.CONFIRM_HERMES_BLOCK_LIVE_SMOKE, 'drlucas', 'Defina CONFIRM_HERMES_BLOCK_LIVE_SMOKE=drlucas.')
  assert.ok(process.env.PAINEL_API_TOKEN, 'PAINEL_API_TOKEN ausente')
  process.env.HERMES_PANEL_URL ||= 'https://hermes.casaldotrafego.com/agente'

  const initial = await readHermesAgendaBlockedDates('drlucas')
  if (!initial.ok) throw new Error(initial.error)
  const testDate = CANDIDATE_DATES.find(date => !(date in initial.data.bloqueios))
  assert.ok(testDate, 'Todas as datas reservadas para smoke já estavam bloqueadas; nada foi alterado.')

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
      name: 'Dr. Lucas — smoke de bloqueio isolado',
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
          entityId?: string
          details?: Record<string, unknown>
        }) => {
          await db.insert(schema.agentActivityLogs).values({
            companyId: params.companyId,
            agentName: params.agentName,
            agentId: params.agentId,
            action: params.action,
            entityType: params.entityType,
            entityId: params.entityId,
            details: params.details,
          })
        },
      },
    })
    mock.module('@/lib/google-calendar-sync', {
      namedExports: { maybeRefreshGoogleCalendarSync: async () => undefined },
    })

    const collectionRoute = await import('../src/app/api/v1/companies/[idOrSlug]/agenda/blocked-dates/route')
    const itemRoute = await import('../src/app/api/v1/companies/[idOrSlug]/agenda/blocked-dates/[date]/route')

    const createRequest = new NextRequest('http://isolated.test/api/v1/companies/drlucas/agenda/blocked-dates', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: testDate, reason: REASON }),
    })
    const createResponse = await collectionRoute.POST(createRequest, {
      params: Promise.resolve({ idOrSlug: 'drlucas' }),
    })
    const createBody = await createResponse.json()
    assert.equal(createResponse.status, 201, JSON.stringify(createBody))

    const [stored] = await db
      .select()
      .from(schema.agendaBlockedDates)
      .where(and(
        eq(schema.agendaBlockedDates.companyId, company.id),
        eq(schema.agendaBlockedDates.date, testDate),
      ))
    assert.equal(stored?.reason, REASON)

    const remoteBlocked = await readHermesAgendaBlockedDates('drlucas')
    if (!remoteBlocked.ok) throw new Error(remoteBlocked.error)
    assert.equal(remoteBlocked.data.bloqueios[testDate], REASON)
    assert.deepEqual(probeBotBlock(testDate), { blocked: true, reason: REASON })

    const deleteRequest = new NextRequest(`http://isolated.test/api/v1/companies/drlucas/agenda/blocked-dates/${testDate}`, {
      method: 'DELETE',
    })
    const deleteResponse = await itemRoute.DELETE(deleteRequest, {
      params: Promise.resolve({ idOrSlug: 'drlucas', date: testDate }),
    })
    const deleteBody = await deleteResponse.json()
    assert.equal(deleteResponse.status, 200, JSON.stringify(deleteBody))

    const remaining = await db
      .select()
      .from(schema.agendaBlockedDates)
      .where(and(
        eq(schema.agendaBlockedDates.companyId, company.id),
        eq(schema.agendaBlockedDates.date, testDate),
      ))
    assert.equal(remaining.length, 0)

    const remoteUnblocked = await readHermesAgendaBlockedDates('drlucas')
    if (!remoteUnblocked.ok) throw new Error(remoteUnblocked.error)
    assert.equal(testDate in remoteUnblocked.data.bloqueios, false)
    assert.deepEqual(probeBotBlock(testDate), { blocked: false, reason: '' })

    const activity = await db.select().from(schema.agentActivityLogs)
    assert.equal(activity.some(row => row.action === 'agenda_block_date'), true)
    assert.equal(activity.some(row => row.action === 'agenda_unblock_date'), true)

    console.log(JSON.stringify({
      ok: true,
      testDate,
      createRouteStatus: createResponse.status,
      deleteRouteStatus: deleteResponse.status,
      isolatedDatabasePersistedThenCleaned: true,
      auditPersisted: true,
      hermesBlockReadBackConfirmed: true,
      hermesUnblockReadBackConfirmed: true,
      botRuntimeSawBlockBeforeBooking: true,
      botRuntimeSawRemoval: true,
    }))
  } finally {
    const cleanup = await restoreHermesAgendaBlockDate('drlucas', testDate, null)
    if (!cleanup.ok) throw new Error(cleanup.error)
    const finalRead = await readHermesAgendaBlockedDates('drlucas')
    if (!finalRead.ok) throw new Error(finalRead.error)
    assert.equal(testDate in finalRead.data.bloqueios, false, 'Data de smoke ainda existe no Hermes')
    console.log(JSON.stringify({ ok: true, testDate, exactOriginalAbsenceRestored: true }))
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
