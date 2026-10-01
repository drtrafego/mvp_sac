// Regressão do engajamento Brevo no Inbox. Sobe Postgres 16 descartável,
// aplica o schema real e chama as duas rotas GET reais do Inbox.
//
// Uso: npx tsx --experimental-test-module-mocks --test scripts/inbox-email-engagement.test.ts

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../src/lib/db/schema'
import { NextRequest as RealNextRequest, NextResponse as RealNextResponse } from 'next/server'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'inbox_email_engagement_test'

function dockerAvailable(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

async function pickFreePort(): Promise<number> {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('porta livre não encontrada'))
      server.close(() => resolve(address.port))
    })
  })
}

async function startPostgres(): Promise<{ url: string; stop: () => void }> {
  spawnSync('docker', ['rm', '-f', '-v', CONTAINER_NAME], { stdio: 'ignore' })
  const port = await pickFreePort()
  execFileSync('docker', [
    'run', '--rm', '-d', '--name', CONTAINER_NAME,
    '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=test',
    '-p', `127.0.0.1:${port}:5432`, 'postgres:16-alpine',
  ])
  const url = `postgres://postgres:test@127.0.0.1:${port}/test`
  const deadline = Date.now() + 30_000
  let ready = false
  while (Date.now() < deadline) {
    const probe = postgres(url, { max: 1, connect_timeout: 2 })
    try {
      await probe`select 1`
      ready = true
      await probe.end({ timeout: 1 })
      break
    } catch {
      await probe.end({ timeout: 1 }).catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  if (!ready) throw new Error('Postgres descartável não respondeu em 30s')
  return { url, stop: () => { spawnSync('docker', ['rm', '-f', '-v', CONTAINER_NAME], { stdio: 'ignore' }) } }
}

async function main() {
  if (!dockerAvailable()) throw new Error('Docker indisponível para o teste com Postgres real')

  const disposable = await startPostgres()
  execFileSync('npx', ['drizzle-kit', 'push', '--force'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL: disposable.url },
    stdio: 'inherit',
  })

  const sql = postgres(disposable.url)
  const testDb = drizzle(sql, { schema })
  try {
    const [company] = await testDb.insert(schema.companies).values({
      name: 'AutonomIA Teste',
      slug: 'autonomia-teste',
    }).returning()

    const engagement = {
      funnelStatus: 'opened',
      lastEventType: 'opened',
      everOpened: true,
      everBounced: false,
      everUnsubscribed: false,
      lastEventAt: '2026-09-09T22:49:24.052-03:00',
      lastStep: 5,
      totalEventsCount: 11,
      syncedAt: '2026-09-22T13:21:38.651Z',
    }

    const [leadWithEngagement, leadWithoutEngagement] = await testDb
      .insert(schema.recoveryLeads)
      .values([
        {
          companyId: company.id,
          phone: '5511999990001',
          eventType: 'outreach',
          channel: 'email',
          miningTags: { origem: 'google_places', emailEngagement: engagement },
        },
        {
          companyId: company.id,
          phone: '5511999990002',
          eventType: 'atendimento',
          channel: 'whatsapp',
          miningTags: { origem: 'manual' },
        },
      ])
      .returning()

    mock.module('@/lib/db', { namedExports: { db: testDb } })
    mock.module('@/lib/auth', { namedExports: { requireCompany: async () => company } })
    mock.module('next/server', {
      namedExports: { NextRequest: RealNextRequest, NextResponse: RealNextResponse },
    })

    const listRoute = await import('../src/app/api/inbox/route')
    const detailRoute = await import('../src/app/api/inbox/[leadId]/route')

    await test('GET /api/inbox expõe emailEngagement e preserva null quando não existe', async () => {
      const response = await listRoute.GET(new RealNextRequest('https://sac.test/api/inbox'))
      assert.equal(response.status, 200)
      const body = await response.json()
      const withEngagement = body.find((lead: { id: number }) => lead.id === leadWithEngagement.id)
      const withoutEngagement = body.find((lead: { id: number }) => lead.id === leadWithoutEngagement.id)
      assert.deepEqual(withEngagement.emailEngagement, engagement)
      assert.equal(withoutEngagement.emailEngagement, null)
      assert.equal(withEngagement.miningTags, undefined, 'a rota não deve vazar o objeto miningTags inteiro')
    })

    await test('GET /api/inbox/[leadId] expõe o mesmo emailEngagement', async () => {
      const response = await detailRoute.GET(
        new RealNextRequest(`https://sac.test/api/inbox/${leadWithEngagement.id}`),
        { params: Promise.resolve({ leadId: String(leadWithEngagement.id) }) }
      )
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.deepEqual(body.lead.emailEngagement, engagement)
      assert.equal(body.lead.miningTags, undefined)
    })
  } finally {
    await sql.end({ timeout: 2 })
    disposable.stop()
  }
}

main()
