import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'
import { loadDashboardOriginPills } from '../src/lib/dashboard/origin-pills'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'hotmart_disabled_state_test'

function dockerAvailable(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

async function pickFreePort(): Promise<number> {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Porta livre indisponível.')))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

async function startPostgres(): Promise<{ url: string; stop: () => void }> {
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' })
  const port = await pickFreePort()
  execFileSync('docker', [
    'run', '--rm', '-d', '--name', CONTAINER_NAME,
    '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=test',
    '-p', `127.0.0.1:${port}:5432`, 'postgres:16-alpine',
  ], { stdio: 'ignore' })

  const url = `postgres://postgres:test@127.0.0.1:${port}/test`
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const probe = postgres(url, { max: 1, connect_timeout: 2 })
    try {
      await probe`select 1`
      await probe.end({ timeout: 1 })
      return {
        url,
        stop: () => { spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' }) },
      }
    } catch {
      await probe.end({ timeout: 1 }).catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 400))
    }
  }
  throw new Error('Postgres descartável não respondeu a tempo.')
}

async function main() {
  if (!dockerAvailable()) throw new Error('Docker é obrigatório para este teste.')

  const previousSecret = process.env.RECUPERAVENDAS_WEBHOOK_SECRET
  process.env.RECUPERAVENDAS_WEBHOOK_SECRET = 'sac-test-secret'

  const disposable = await startPostgres()
  const sql = postgres(disposable.url)

  try {
    execFileSync('npx', ['drizzle-kit', 'push', '--force'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DATABASE_URL: disposable.url },
      stdio: 'ignore',
    })

    const database = drizzle(sql, { schema })

    await database.insert(schema.companies).values([
      { id: 101, name: 'Dr. Lucas', slug: 'dr-lucas' },
      { id: 202, name: 'Empresa Ativa', slug: 'empresa-ativa' },
    ])
    await database.insert(schema.settings).values([
      {
        companyId: 101,
        hotmartEnabled: false,
        hotmartWebhookToken: 'hottok-dr-lucas',
        hotmartClientId: 'client-dr-lucas',
      },
      {
        companyId: 202,
        hotmartEnabled: true,
        hotmartWebhookToken: 'hottok-ativa',
      },
    ])
    await database.insert(schema.recoveryLeads).values([
      {
        companyId: 101,
        phone: '5511900000001',
        platform: 'hotmart',
        trackingSource: 'hotmart',
        eventType: 'boleto',
        status: 'active',
      },
      {
        companyId: 202,
        phone: '5511900000002',
        platform: 'hotmart',
        trackingSource: 'hotmart',
        eventType: 'boleto',
        status: 'active',
      },
      {
        companyId: 101,
        phone: '5511900000003',
        platform: 'greenn',
        trackingSource: 'greenn',
        eventType: 'pix',
        status: 'active',
      },
      {
        companyId: 101,
        phone: '5511900000004',
        platform: 'zouti',
        trackingSource: 'zouti',
        eventType: 'boleto',
        status: 'active',
      },
    ])

    mock.module('@/lib/db', { namedExports: { db: database } })
    mock.module('@/lib/auth', {
      namedExports: {
        requireCompany: async () => {
          const [company] = await database
            .select()
            .from(schema.companies)
            .where(eq(schema.companies.id, 101))
          return company
        },
        getCurrentUser: async () => ({ isAdmin: true }),
      },
    })

    const { GET, PUT } = await import('../src/app/api/settings/route')
    const { getCompanySidebarData } = await import('../src/lib/company-sidebar')
    const { POST } = await import('../src/app/api/webhooks/hotmart/[slug]/route')
    const { NextRequest } = await import('next/server')

    await test('desabilitar Hotmart persiste e a leitura seguinte devolve false', async () => {
      const enableResponse = await PUT(new NextRequest('http://localhost/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hotmartEnabled: true }),
      }))
      assert.equal(enableResponse.status, 200)
      assert.equal((await enableResponse.json()).hotmartEnabled, true)

      const disableResponse = await PUT(new NextRequest('http://localhost/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hotmartEnabled: false }),
      }))
      assert.equal(disableResponse.status, 200)
      assert.equal((await disableResponse.json()).hotmartEnabled, false)

      const reread = await GET()
      assert.equal(reread.status, 200)
      assert.equal((await reread.json()).hotmartEnabled, false)
    })

    await test('menu e origem do painel respeitam hotmartEnabled=false mesmo com token e lead antigo', async () => {
      const sidebar = await getCompanySidebarData(101)
      assert.equal(sidebar.activeConnections.hotmart, false)

      const pills = await loadDashboardOriginPills(database, 101)
      assert.equal(pills.categories.has('hotmart'), false)
      assert.equal(pills.categories.has('greenn'), true)
      assert.equal(pills.categories.has('zouti'), true)
    })

    await test('Hotmart ativa em outro tenant continua aparecendo', async () => {
      const sidebar = await getCompanySidebarData(202)
      assert.equal(sidebar.activeConnections.hotmart, true)

      const pills = await loadDashboardOriginPills(database, 202)
      assert.equal(pills.categories.has('hotmart'), true)
    })

    await test('webhook stale da Hotmart desligada é recusado e registrado sem processar lead', async () => {
      const before = await database
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.companyId, 101))

      const response = await POST(new NextRequest('http://localhost/api/webhooks/hotmart/dr-lucas?token=sac-test-secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'evt-stale-1',
          event: 'PURCHASE_APPROVED',
          hottok: 'hottok-dr-lucas',
          data: { purchase: { transaction: 'tx-stale-1' }, buyer: { email: 'lead@example.com' } },
        }),
      }), { params: Promise.resolve({ slug: 'dr-lucas' }) })

      assert.equal(response.status, 403)

      const after = await database
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.companyId, 101))
      assert.equal(after.length, before.length)

      const logs = await database
        .select()
        .from(schema.webhookReceived)
        .where(eq(schema.webhookReceived.companyId, 101))
      assert.equal(logs.length, 1)
      assert.equal(logs[0].processed, false)
      assert.equal(logs[0].skipReason, 'hotmart_integration_disabled')
    })
  } finally {
    await sql.end({ timeout: 2 })
    disposable.stop()
    if (previousSecret === undefined) {
      delete process.env.RECUPERAVENDAS_WEBHOOK_SECRET
    } else {
      process.env.RECUPERAVENDAS_WEBHOOK_SECRET = previousSecret
    }
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
