import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mock } from 'node:test'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'provider_toggle_race_test'
const ROUNDS = 30

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

async function main(): Promise<void> {
  if (!dockerAvailable()) throw new Error('Docker é obrigatório para este teste.')

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
      { id: 401, name: 'Empresa Race', slug: 'empresa-race' },
      { id: 402, name: 'Empresa Sem Settings', slug: 'empresa-sem-settings-race' },
    ])
    await database.insert(schema.settings).values({
      companyId: 401,
      hotmartEnabled: true,
      greennEnabled: true,
      kiwifyEnabled: true,
      zoutiEnabled: true,
      greennWebhookToken: 'greenn-race-token',
    })

    let currentCompanyId = 402
    const requireCompany = async () => {
      const [company] = await database
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.id, currentCompanyId))
      return company
    }

    mock.module('@/lib/db', { namedExports: { db: database } })
    mock.module('@/lib/auth', {
      namedExports: {
        requireCompany,
        getCurrentUser: async () => ({ isAdmin: true }),
      },
    })

    const { PUT } = await import('../src/app/api/settings/route')
    const { NextRequest } = await import('next/server')
    const request = (body: Record<string, unknown>) => new NextRequest('http://localhost/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    // O ramo INSERT continua preenchendo os gates omitidos com true.
    const createResponse = await PUT(request({ greennEnabled: false }))
    assert.equal(createResponse.status, 200)
    const [created] = await database
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.companyId, 402))
    assert.equal(created.hotmartEnabled, true)
    assert.equal(created.greennEnabled, false)
    assert.equal(created.kiwifyEnabled, true)
    assert.equal(created.zoutiEnabled, true)

    currentCompanyId = 401
    const maskedSecretResponse = await PUT(request({ greennWebhookToken: '****oken' }))
    assert.equal(maskedSecretResponse.status, 200)
    const [credentialRow] = await database
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.companyId, 401))
    assert.equal(credentialRow.greennWebhookToken, 'greenn-race-token')

    const newSecretResponse = await PUT(request({ greennWebhookToken: 'greenn-updated-token' }))
    assert.equal(newSecretResponse.status, 200)
    const [updatedCredentialRow] = await database
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.companyId, 401))
    assert.equal(updatedCredentialRow.greennWebhookToken, 'greenn-updated-token')

    const firstFive: string[] = []
    let lostUpdates = 0

    for (let round = 1; round <= ROUNDS; round += 1) {
      await database
        .update(schema.settings)
        .set({ greennEnabled: true, kiwifyEnabled: true })
        .where(eq(schema.settings.companyId, 401))

      const [greennResponse, kiwifyResponse] = await Promise.all([
        PUT(request({ greennEnabled: false })),
        PUT(request({ kiwifyEnabled: false })),
      ])
      assert.equal(greennResponse.status, 200)
      assert.equal(kiwifyResponse.status, 200)

      const [row] = await database
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.companyId, 401))
      if (row.greennEnabled || row.kiwifyEnabled) {
        lostUpdates += 1
        if (firstFive.length < 5) {
          firstFive.push(`round=${round}:greenn=${row.greennEnabled},kiwify=${row.kiwifyEnabled}`)
        }
      }
      assert.equal(row.greennWebhookToken, 'greenn-updated-token')
    }

    const result = { rounds: ROUNDS, lostUpdates, firstFive }
    console.log(JSON.stringify(result))
    assert.equal(lostUpdates, 0, `Lost updates detectados: ${JSON.stringify(firstFive)}`)
  } finally {
    await sql.end({ timeout: 2 })
    disposable.stop()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
