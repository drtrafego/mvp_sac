import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { test, mock } from 'node:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import * as schema from '../src/lib/db/schema'

const ROOT = path.resolve(__dirname, '..')
const CONTAINER = 'native_availability_sync_test'

async function freePort(): Promise<number> {
  const net = await import('node:net')
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
  spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })
  const port = await freePort()
  execFileSync('docker', [
    'run', '--rm', '-d', '--name', CONTAINER,
    '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=test',
    '-p', `127.0.0.1:${port}:5432`, 'postgres:16-alpine',
  ])
  const url = `postgres://postgres:test@127.0.0.1:${port}/test`
  const deadline = Date.now() + 30_000
  while (true) {
    try {
      const probe = postgres(url, { max: 1, connect_timeout: 2 })
      await probe`select 1`
      await probe.end({ timeout: 1 })
      break
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  }
  execFileSync('npx', ['drizzle-kit', 'push', '--force'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  })
  return { url, stop: () => spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' }) }
}

const lucasSchedule = {
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

async function main() {
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
    throw new Error('Docker é obrigatório para esta regressão')
  }
  const disposable = await startPostgres()
  const sql = postgres(disposable.url)
  const testDb = drizzle(sql, { schema })
  const [drLucas] = await testDb.insert(schema.companies).values({ name: 'Dr. Lucas', slug: 'drlucas' }).returning()
  const [gramado] = await testDb.insert(schema.companies).values({ name: 'Gramado Plazza', slug: 'gramado-plaza' }).returning()
  const [other] = await testDb.insert(schema.companies).values({ name: 'Outra', slug: 'outra' }).returning()
  await testDb.insert(schema.settings).values([
    { companyId: drLucas.id, availabilitySchedule: { ...lucasSchedule, duracaoSlotMinutos: 99 } },
    { companyId: other.id, availabilitySchedule: lucasSchedule },
  ])

  let authenticatedCompany = drLucas
  mock.module('@/lib/db', { namedExports: { db: testDb } })
  mock.module('@/lib/agent-auth', {
    namedExports: {
      authenticateAgentRequest: async () => ({
        error: null,
        context: { company: authenticatedCompany, agentName: 'teste', agentId: 'teste' },
      }),
      logAgentActivity: async () => undefined,
    },
  })
  mock.module('@/lib/google-calendar-sync', { namedExports: { maybeRefreshGoogleCalendarSync: async () => undefined } })
  mock.module('@/lib/webhook-auth', { namedExports: { checkHermesWebhookToken: () => ({ ok: true }) } })
  mock.module('@/lib/hermes-control-panel', {
    namedExports: {
      shouldSyncHermesAgenda: (slug: string) => slug === 'drlucas',
      syncHermesAgendaSchedule: async () => ({ ok: true, status: 200, data: {} }),
      restoreHermesAgendaConfig: async () => ({ ok: true, status: 200, data: {} }),
      syncHermesAgendaBlockDate: async () => ({ ok: true, status: 200, data: {} }),
    },
  })

  try {
    const native = await import('../src/lib/native-availability')
    const scheduleRoute = await import('../src/app/api/v1/companies/[idOrSlug]/agenda/schedule/route')
    const webhookRoute = await import('../src/app/api/webhooks/hermes/[slug]/availability/route')

    await test('payload nativo exige fonte, cursor e horário válidos', () => {
      assert.equal(native.parseNativeAvailabilityPayload('drlucas', {
        schedule: lucasSchedule,
        source: 'reservations_api',
        cursor: 'sha256:errado',
        capturedAt: new Date().toISOString(),
      }).ok, false)
      assert.equal(native.parseNativeAvailabilityPayload('drlucas', {
        schedule: { segunda: lucasSchedule.segunda },
        source: 'bot_file',
        cursor: 'sha256:incompleto',
        capturedAt: new Date().toISOString(),
      }).ok, false, 'não pode completar um snapshot parcial com defaults do SAC')
    })

    await test('webhook normaliza o formato legado de faixa única usado pelos coletores', () => {
      const legacySchedule = Object.fromEntries(Object.entries(lucasSchedule).map(([key, value]) => [
        key,
        Array.isArray(value) ? value[0] : value,
      ]))
      const parsed = native.parseNativeAvailabilityPayload('drlucas', {
        schedule: legacySchedule,
        source: 'bot_file',
        cursor: 'sha256:legado',
        capturedAt: new Date().toISOString(),
      })
      assert.equal(parsed.ok, true)
      if (parsed.ok) assert.deepEqual(parsed.value.schedule, lucasSchedule)
    })

    await test('webhook autenticado grava o snapshot real no Postgres', async () => {
      const req = new NextRequest('http://localhost/api/webhooks/hermes/drlucas/availability', {
        method: 'POST',
        body: JSON.stringify({
          schedule: lucasSchedule,
          source: 'bot_file',
          cursor: 'sha256:lucas-v1',
          capturedAt: '2026-09-23T10:00:00.000Z',
        }),
        headers: { 'content-type': 'application/json' },
      })
      const res = await webhookRoute.POST(req, { params: Promise.resolve({ slug: 'drlucas' }) })
      assert.equal(res.status, 200)
      const rows = await testDb.select().from(schema.nativeAvailabilitySchedules)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].sourceCursor, 'sha256:lucas-v1')
      assert.deepEqual(rows[0].schedule, lucasSchedule)
    })

    await test('snapshot atrasado não sobrescreve uma coleta mais recente', async () => {
      await native.upsertNativeAvailabilitySnapshot('drlucas', {
        schedule: { ...lucasSchedule, duracaoSlotMinutos: 60 },
        source: 'bot_file',
        sourceCursor: 'sha256:atrasado',
        capturedAt: new Date('2026-09-23T09:59:00.000Z'),
      })
      const [row] = await testDb.select().from(schema.nativeAvailabilitySchedules)
      assert.equal(row.sourceCursor, 'sha256:lucas-v1')
      assert.equal((row.schedule as typeof lucasSchedule).duracaoSlotMinutos, 15)
    })

    await test('GET ignora valor legado sem edição manual e entrega o espelho nativo editável', async () => {
      const req = new NextRequest('http://localhost/api/v1/companies/drlucas/agenda/schedule')
      const res = await scheduleRoute.GET(req, { params: Promise.resolve({ idOrSlug: 'drlucas' }) })
      const body = await res.json()
      assert.equal(res.status, 200)
      assert.equal(body.readOnly, false)
      assert.equal(body.sourceStatus, 'native_snapshot_imported')
      assert.equal(body.sourceLabel, 'Arquivo nativo do bot (/opt/data/agenda_config.json)')
      assert.equal(body.schedule.duracaoSlotMinutos, 15, 'não pode vazar o valor legado 99 de settings')
    })

    await test('PUT de empresa com bot nativo grava override manual sem alterar o snapshot', async () => {
      const req = new NextRequest('http://localhost/api/v1/companies/drlucas/agenda/schedule', {
        method: 'PUT', body: JSON.stringify({ ...lucasSchedule, duracaoSlotMinutos: 60 }),
      })
      const res = await scheduleRoute.PUT(req, { params: Promise.resolve({ idOrSlug: 'drlucas' }) })
      assert.equal(res.status, 200)
      const [legacy] = await testDb.select().from(schema.settings).where(eq(schema.settings.companyId, drLucas.id))
      assert.equal((legacy.availabilitySchedule as typeof lucasSchedule).duracaoSlotMinutos, 60)
      assert.equal(legacy.availabilityScheduleManual, true)
      const [mirror] = await testDb.select().from(schema.nativeAvailabilitySchedules)
      assert.equal((mirror.schedule as typeof lucasSchedule).duracaoSlotMinutos, 15)
    })

    await test('Gramado continua somente leitura enquanto a fonte real não oferece escrita', async () => {
      const gramadoSchedule = {
        ...lucasSchedule,
        segunda: [{ inicio: '18:00', fim: '22:30' }],
        timezone: 'America/Sao_Paulo',
        duracaoSlotMinutos: 30,
      }
      await native.upsertNativeAvailabilitySnapshot('gramado-plaza', {
        schedule: gramadoSchedule,
        source: 'reservations_api',
        sourceCursor: 'sha256:gramado-v1',
        capturedAt: new Date('2026-09-30T20:00:00.000Z'),
      })
      authenticatedCompany = gramado

      const getReq = new NextRequest('http://localhost/api/v1/companies/gramado-plaza/agenda/schedule')
      const getRes = await scheduleRoute.GET(getReq, { params: Promise.resolve({ idOrSlug: 'gramado-plaza' }) })
      const getBody = await getRes.json()
      assert.equal(getRes.status, 200)
      assert.equal(getBody.readOnly, true)
      assert.equal(getBody.sourceStatus, 'native_snapshot_imported')
      assert.deepEqual(getBody.schedule, gramadoSchedule)

      const putReq = new NextRequest('http://localhost/api/v1/companies/gramado-plaza/agenda/schedule', {
        method: 'PUT', body: JSON.stringify({ ...gramadoSchedule, duracaoSlotMinutos: 60 }),
      })
      const putRes = await scheduleRoute.PUT(putReq, { params: Promise.resolve({ idOrSlug: 'gramado-plaza' }) })
      const putBody = await putRes.json()
      assert.equal(putRes.status, 409)
      assert.equal(putBody.code, 'NATIVE_AGENDA_WRITE_UNAVAILABLE')
      const gramadoSettings = await testDb.select().from(schema.settings).where(eq(schema.settings.companyId, gramado.id))
      assert.equal(gramadoSettings.length, 0)
    })

    await test('empresa sem bot nativo preserva edição manual', async () => {
      authenticatedCompany = other
      const req = new NextRequest('http://localhost/api/v1/companies/outra/agenda/schedule', {
        method: 'PUT', body: JSON.stringify({ ...lucasSchedule, duracaoSlotMinutos: 30 }),
      })
      const res = await scheduleRoute.PUT(req, { params: Promise.resolve({ idOrSlug: 'outra' }) })
      assert.equal(res.status, 200)
      const [row] = await testDb.select().from(schema.settings).where(eq(schema.settings.companyId, other.id))
      assert.equal((row.availabilitySchedule as typeof lucasSchedule).duracaoSlotMinutos, 30)
    })
  } finally {
    await sql.end({ timeout: 2 })
    disposable.stop()
  }
}

main().catch(error => {
  console.error(error)
  spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })
  process.exitCode = 1
})
