import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { mock, test } from 'node:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { NextRequest } from 'next/server'
import * as schema from '../src/lib/db/schema'

const ROOT = path.resolve(__dirname, '..')
const CONTAINER = 'analytics_route_agent_metrics_test'

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
  spawnSync('docker', ['rm', '-f', '-v', CONTAINER], { stdio: 'ignore' })
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
  return { url, stop: () => spawnSync('docker', ['rm', '-f', '-v', CONTAINER], { stdio: 'ignore' }) }
}

async function main() {
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
    throw new Error('Docker é obrigatório para o contrato real da rota de analytics')
  }

  const disposable = await startPostgres()
  const sql = postgres(disposable.url)
  const testDb = drizzle(sql, { schema })

  try {
    const [companyA, companyB] = await testDb.insert(schema.companies).values([
      { name: 'Empresa A', slug: 'empresa-a' },
      { name: 'Empresa B', slug: 'empresa-b' },
    ]).returning()

    await testDb.insert(schema.agentActivityLogs).values([
      { companyId: companyA.id, agentId: 'renato', agentName: 'Renato', action: 'send_message', entityType: 'message', createdAt: new Date('2026-10-01T12:30:00.000Z') },
      { companyId: companyA.id, agentId: 'renato', agentName: 'Renato', action: 'update_stage', entityType: 'lead', createdAt: new Date('2026-10-01T14:00:00.000Z') },
      { companyId: companyA.id, agentId: 'luana', agentName: 'Luana', action: 'create_lead', entityType: 'lead', createdAt: new Date('2026-09-30T23:59:59.000Z') },
      { companyId: companyB.id, agentId: 'bia', agentName: 'Bia', action: 'send_message', entityType: 'message', createdAt: new Date('2026-10-01T13:00:00.000Z') },
    ])

    let authenticatedCompany = companyA
    mock.module('@/lib/db', { namedExports: { db: testDb } })
    mock.module('@/lib/agent-auth', {
      namedExports: {
        authenticateAgentRequest: async () => ({
          error: null,
          context: { company: authenticatedCompany },
        }),
      },
    })

    const analyticsRoute = await import('../src/app/api/v1/companies/[idOrSlug]/analytics/route')

    await test('analytics retorna somente ações da empresa autenticada no período ISO com timezone', async () => {
      const response = await analyticsRoute.GET(
        new NextRequest('http://localhost/api/v1/companies/empresa-b/analytics?from=2026-10-01T09:00:00-03:00&to=2026-10-01T23:59:59-03:00'),
        { params: Promise.resolve({ idOrSlug: 'empresa-b' }) },
      )
      const body = await response.json()

      assert.equal(response.status, 200)
      assert.equal(body.company.id, companyA.id, 'a URL não pode trocar o tenant autenticado')
      assert.equal(body.agentMetrics.totalActions, 2)
      assert.deepEqual(body.agentMetrics.agents, [{
        id: 'renato', name: 'Renato', totalActions: 2,
        actions: { send_message: 1, update_stage: 1 },
      }])
    })

    await test('analytics troca de tenant apenas pelo contexto autenticado', async () => {
      authenticatedCompany = companyB
      const response = await analyticsRoute.GET(
        new NextRequest('http://localhost/api/v1/companies/empresa-a/analytics?from=2026-10-01&to=2026-10-01'),
        { params: Promise.resolve({ idOrSlug: 'empresa-a' }) },
      )
      const body = await response.json()

      assert.equal(response.status, 200)
      assert.equal(body.company.id, companyB.id)
      assert.equal(body.agentMetrics.totalActions, 1)
      assert.deepEqual(body.agentMetrics.agents.map((agent: { id: string }) => agent.id), ['bia'])
    })

    await test('analytics rejeita ISO sem timezone antes de consultar métricas', async () => {
      const response = await analyticsRoute.GET(
        new NextRequest('http://localhost/api/v1/companies/empresa-b/analytics?from=2026-10-01T09:00:00'),
        { params: Promise.resolve({ idOrSlug: 'empresa-b' }) },
      )
      const body = await response.json()

      assert.equal(response.status, 400)
      assert.equal(body.code, 'INVALID_PERIOD')
    })
  } finally {
    await sql.end({ timeout: 2 })
    disposable.stop()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
