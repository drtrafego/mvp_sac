import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'
import { loadDashboardOriginPills } from '../src/lib/dashboard/origin-pills'

type Provider = 'greenn' | 'kiwify' | 'zouti'
type EnabledField = 'greennEnabled' | 'kiwifyEnabled' | 'zoutiEnabled'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CHECKOUT_ENABLED_FIELDS = ['hotmartEnabled', 'greennEnabled', 'kiwifyEnabled', 'zoutiEnabled'] as const

const cases: Record<Provider, {
  enabledField: EnabledField
  tokenField: 'greennWebhookToken' | 'kiwifyWebhookToken' | 'zoutiWebhookToken'
  token: string
  payload: Record<string, unknown>
}> = {
  greenn: {
    enabledField: 'greennEnabled',
    tokenField: 'greennWebhookToken',
    token: 'greenn-test-token',
    payload: { event: 'checkoutAbandoned', type: 'lead', token: 'greenn-test-token', lead: { email: 'test@example.com' } },
  },
  kiwify: {
    enabledField: 'kiwifyEnabled',
    tokenField: 'kiwifyWebhookToken',
    token: 'kiwify-test-token',
    payload: { id: 'checkout-test', status: 'abandoned', email: 'test@example.com' },
  },
  zouti: {
    enabledField: 'zoutiEnabled',
    tokenField: 'zoutiWebhookToken',
    token: 'zouti-test-token',
    payload: { id: 'ab_test', event: 'abandoned_cart', step: 'customer', lead: { email: 'test@example.com' } },
  },
}

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

async function startPostgres(provider: Provider): Promise<{ url: string; stop: () => void }> {
  const containerName = `${provider}_disabled_state_test`
  spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' })
  const port = await pickFreePort()
  execFileSync('docker', [
    'run', '--rm', '-d', '--name', containerName,
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
        stop: () => { spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' }) },
      }
    } catch {
      await probe.end({ timeout: 1 }).catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 400))
    }
  }
  throw new Error('Postgres descartável não respondeu a tempo.')
}

export async function runProviderDisabledStateTests(provider: Provider): Promise<void> {
  if (!dockerAvailable()) throw new Error('Docker é obrigatório para este teste.')

  const config = cases[provider]
  const previousSecret = process.env.RECUPERAVENDAS_WEBHOOK_SECRET
  process.env.RECUPERAVENDAS_WEBHOOK_SECRET = 'sac-test-secret'

  const disposable = await startPostgres(provider)
  const sql = postgres(disposable.url)

  try {
    execFileSync('npx', ['drizzle-kit', 'push', '--force'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DATABASE_URL: disposable.url },
      stdio: 'ignore',
    })

    const database = drizzle(sql, { schema })
    await database.insert(schema.companies).values([
      { id: 101, name: 'Empresa Desabilitada', slug: 'empresa-desabilitada' },
      { id: 202, name: 'Empresa Ativa', slug: 'empresa-ativa' },
      { id: 303, name: 'Empresa Sem Settings', slug: 'empresa-sem-settings' },
    ])
    await database.insert(schema.settings).values([
      { companyId: 101, [config.enabledField]: false, [config.tokenField]: config.token },
      { companyId: 202, [config.enabledField]: true, [config.tokenField]: `${config.token}-ativa` },
    ])
    await database.insert(schema.recoveryLeads).values([
      {
        companyId: 101,
        phone: '5511900000001',
        platform: provider,
        trackingSource: provider,
        eventType: 'boleto',
        status: 'active',
      },
      {
        companyId: 101,
        phone: '5511900000002',
        platform: 'hotmart',
        trackingSource: 'hotmart',
        eventType: 'boleto',
        status: 'active',
      },
      {
        companyId: 202,
        phone: '5511900000003',
        platform: provider,
        trackingSource: provider,
        eventType: 'boleto',
        status: 'active',
      },
    ])

    let currentCompanyId = 101
    const companyContext = async () => {
      const [company] = await database
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.id, currentCompanyId))
      return company
    }

    mock.module('@/lib/db', { namedExports: { db: database } })
    mock.module('@/lib/auth', {
      namedExports: {
        requireCompany: companyContext,
        getCurrentUser: async () => ({ isAdmin: true }),
      },
    })
    mock.module('@/lib/agent-auth', {
      namedExports: {
        authenticateAgentRequest: async () => ({
          error: null,
          context: { company: await companyContext() },
        }),
      },
    })

    const { GET, PUT } = await import('../src/app/api/settings/route')
    const { GET: agentGet, PATCH } = await import('../src/app/api/v1/companies/[idOrSlug]/settings/route')
    const { getCompanySidebarData } = await import('../src/lib/company-sidebar')
    const { NextRequest } = await import('next/server')
    const webhook = provider === 'greenn'
      ? await import('../src/app/api/webhooks/greenn/[slug]/route')
      : provider === 'kiwify'
        ? await import('../src/app/api/webhooks/kiwify/[slug]/route')
        : await import('../src/app/api/webhooks/zouti/[slug]/route')

    await test(`${provider}: GET sem linha de settings devolve todos os gates ligados`, async () => {
      currentCompanyId = 303
      const response = await GET()
      const body = await response.json()
      assert.equal(body.hotmartEnabled, true)
      assert.equal(body.greennEnabled, true)
      assert.equal(body.kiwifyEnabled, true)
      assert.equal(body.zoutiEnabled, true)
      currentCompanyId = 101
    })

    await test(`${provider}: PUT/GET do painel persiste o gate sem afetar os demais`, async () => {
      const enableResponse = await PUT(new NextRequest('http://localhost/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [config.enabledField]: true }),
      }))
      assert.equal(enableResponse.status, 200)
      assert.equal((await enableResponse.json())[config.enabledField], true)

      const disableResponse = await PUT(new NextRequest('http://localhost/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [config.enabledField]: false }),
      }))
      assert.equal(disableResponse.status, 200)

      const reread = await GET()
      const body = await reread.json()
      assert.equal(body[config.enabledField], false)
      for (const field of CHECKOUT_ENABLED_FIELDS) {
        if (field !== config.enabledField) assert.equal(body[field], true)
      }
    })

    await test(`${provider}: GET/PATCH da API v1 expõe, valida e grava o gate`, async () => {
      const invalid = await PATCH(new NextRequest('http://localhost/api/v1/companies/empresa-desabilitada/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [config.enabledField]: 'false' }),
      }), { params: Promise.resolve({ idOrSlug: 'empresa-desabilitada' }) })
      assert.equal(invalid.status, 400)

      const patched = await PATCH(new NextRequest('http://localhost/api/v1/companies/empresa-desabilitada/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [config.enabledField]: true }),
      }), { params: Promise.resolve({ idOrSlug: 'empresa-desabilitada' }) })
      assert.equal(patched.status, 200)
      assert.equal((await patched.json()).settings[config.enabledField], true)

      const read = await agentGet(new NextRequest('http://localhost/api/v1/companies/empresa-desabilitada/settings'), {
        params: Promise.resolve({ idOrSlug: 'empresa-desabilitada' }),
      })
      assert.equal((await read.json()).settings[config.enabledField], true)

      await database
        .update(schema.settings)
        .set({ [config.enabledField]: false })
        .where(eq(schema.settings.companyId, 101))
    })

    await test(`${provider}: menu e origem respeitam o gate por tenant`, async () => {
      const disabledSidebar = await getCompanySidebarData(101)
      assert.equal(disabledSidebar.activeConnections[provider], false)
      const disabledPills = await loadDashboardOriginPills(database, 101)
      assert.equal(disabledPills.categories.has(provider), false)
      assert.equal(disabledPills.categories.has('hotmart'), true)

      const activeSidebar = await getCompanySidebarData(202)
      assert.equal(activeSidebar.activeConnections[provider], true)
      const activePills = await loadDashboardOriginPills(database, 202)
      assert.equal(activePills.categories.has(provider), true)
    })

    await test(`${provider}: webhook desligado retorna 403, registra a razão e não cria lead`, async () => {
      const before = await database
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.companyId, 101))

      const response = await webhook.POST(new NextRequest(`http://localhost/api/webhooks/${provider}/empresa-desabilitada?token=sac-test-secret`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(config.payload),
      }), { params: Promise.resolve({ slug: 'empresa-desabilitada' }) })
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
      assert.equal(logs[0].skipReason, `${provider}_integration_disabled`)
    })
  } finally {
    await sql.end({ timeout: 2 })
    disposable.stop()
    if (previousSecret === undefined) delete process.env.RECUPERAVENDAS_WEBHOOK_SECRET
    else process.env.RECUPERAVENDAS_WEBHOOK_SECRET = previousSecret
  }
}
