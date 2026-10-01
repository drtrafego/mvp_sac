import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
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
      ...Array.from({ length: ROUNDS }, (_, index) => ({
        id: 501 + index,
        name: `Empresa Insert Race ${index + 1}`,
        slug: `empresa-insert-race-${index + 1}`,
      })),
      ...Array.from({ length: ROUNDS * 2 }, (_, index) => ({
        id: 1001 + index,
        name: `Empresa Placeholder Race ${index + 1}`,
        slug: `empresa-placeholder-race-${index + 1}`,
      })),
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
    const requestCompanyId = new AsyncLocalStorage<number>()
    const requireCompany = async () => {
      const companyId = requestCompanyId.getStore() ?? currentCompanyId
      const [company] = await database
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.id, companyId))
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
    const putForCompany = (companyId: number, body: Record<string, unknown>) => (
      requestCompanyId.run(companyId, () => PUT(request(body)))
    )

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

    let maskedPlaceholderRejectedRequests = 0
    let maskedPlaceholderLiteralWrites = 0
    let maskedPlaceholderNonNullCredentials = 0
    let maskedPlaceholderMissingRowsOrLostIntents = 0
    const maskedPlaceholderExamples: string[] = []

    for (let round = 1; round <= ROUNDS; round += 1) {
      const companyIds = [999 + round * 2, 1000 + round * 2]
      const responses = await Promise.allSettled(companyIds.map(companyId => (
        putForCompany(companyId, {
          greennEnabled: false,
          hotmartClientSecret: '****1234',
          hotmartWebhookToken: '****1234',
        })
      )))
      const rejected = responses.filter(result => result.status === 'rejected').length
      const badStatuses = responses.filter(
        result => result.status === 'fulfilled' && result.value.status !== 200,
      ).length
      maskedPlaceholderRejectedRequests += rejected + badStatuses

      const rows = await Promise.all(companyIds.map(async companyId => {
        const [row] = await database
          .select()
          .from(schema.settings)
          .where(eq(schema.settings.companyId, companyId))
        return row
      }))
      const literalWrites = rows.filter(row => (
        row?.hotmartClientSecret === '****1234'
        || row?.hotmartWebhookToken === '****1234'
      )).length
      const nonNullCredentials = rows.filter(row => row && (
        row.hotmartClientSecret !== null
        || row.hotmartWebhookToken !== null
      )).length
      const missingRowsOrLostIntents = rows.filter(row => !row || row.greennEnabled).length
      maskedPlaceholderLiteralWrites += literalWrites
      maskedPlaceholderNonNullCredentials += nonNullCredentials
      maskedPlaceholderMissingRowsOrLostIntents += missingRowsOrLostIntents

      if ((rejected > 0 || badStatuses > 0 || nonNullCredentials > 0 || missingRowsOrLostIntents > 0)
        && maskedPlaceholderExamples.length < 5) {
        maskedPlaceholderExamples.push(JSON.stringify({
          round,
          rejected,
          badStatuses,
          literalWrites,
          nonNullCredentials,
          missingRowsOrLostIntents,
        }))
      }
    }

    const insertRaceExamples: string[] = []
    let insertRaceRejectedRequests = 0
    let insertRaceLostIntents = 0

    for (let round = 1; round <= ROUNDS; round += 1) {
      currentCompanyId = 500 + round
      const responses = await Promise.allSettled([
        PUT(request({ hotmartEnabled: false })),
        PUT(request({ greennEnabled: false })),
        PUT(request({ kiwifyEnabled: false })),
        PUT(request({ zoutiEnabled: false })),
      ])
      const rejected = responses.filter(result => result.status === 'rejected').length
      const badStatuses = responses.filter(
        result => result.status === 'fulfilled' && result.value.status !== 200,
      ).length
      insertRaceRejectedRequests += rejected

      const [row] = await database
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.companyId, currentCompanyId))
      const lostIntent = !row
        || row.hotmartEnabled
        || row.greennEnabled
        || row.kiwifyEnabled
        || row.zoutiEnabled
        || badStatuses > 0
        || rejected > 0
      if (lostIntent) {
        insertRaceLostIntents += 1
        if (insertRaceExamples.length < 5) {
          insertRaceExamples.push(JSON.stringify({
            round,
            rejected,
            badStatuses,
            gates: row && {
              hotmart: row.hotmartEnabled,
              greenn: row.greennEnabled,
              kiwify: row.kiwifyEnabled,
              zouti: row.zoutiEnabled,
            },
          }))
        }
      }
    }

    currentCompanyId = 401
    const updateRaceExamples: string[] = []
    let updateRaceLostIntents = 0

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
        updateRaceLostIntents += 1
        if (updateRaceExamples.length < 5) {
          updateRaceExamples.push(`round=${round}:greenn=${row.greennEnabled},kiwify=${row.kiwifyEnabled}`)
        }
      }
      assert.equal(row.greennWebhookToken, 'greenn-updated-token')
    }

    const result = {
      maskedPlaceholderCreateRace: {
        rounds: ROUNDS,
        companiesPerRound: 2,
        rejectedRequests: maskedPlaceholderRejectedRequests,
        literalWrites: maskedPlaceholderLiteralWrites,
        nonNullCredentials: maskedPlaceholderNonNullCredentials,
        missingRowsOrLostIntents: maskedPlaceholderMissingRowsOrLostIntents,
        firstFive: maskedPlaceholderExamples,
      },
      insertRace: {
        rounds: ROUNDS,
        writersPerRound: 4,
        rejectedRequests: insertRaceRejectedRequests,
        lostIntents: insertRaceLostIntents,
        firstFive: insertRaceExamples,
      },
      updateRace: {
        rounds: ROUNDS,
        writersPerRound: 2,
        lostIntents: updateRaceLostIntents,
        firstFive: updateRaceExamples,
      },
    }
    console.log(JSON.stringify(result))
    assert.equal(maskedPlaceholderRejectedRequests, 0, `Requests com placeholder rejeitados: ${JSON.stringify(maskedPlaceholderExamples)}`)
    assert.equal(maskedPlaceholderLiteralWrites, 0, `Placeholders persistidos: ${JSON.stringify(maskedPlaceholderExamples)}`)
    assert.equal(maskedPlaceholderNonNullCredentials, 0, `Credenciais mascaradas não viraram null: ${JSON.stringify(maskedPlaceholderExamples)}`)
    assert.equal(maskedPlaceholderMissingRowsOrLostIntents, 0, `Linhas/toggles perdidos: ${JSON.stringify(maskedPlaceholderExamples)}`)
    assert.equal(insertRaceRejectedRequests, 0, `Requests rejeitados no INSERT: ${JSON.stringify(insertRaceExamples)}`)
    assert.equal(insertRaceLostIntents, 0, `Intenções perdidas no INSERT: ${JSON.stringify(insertRaceExamples)}`)
    assert.equal(updateRaceLostIntents, 0, `Intenções perdidas no UPDATE: ${JSON.stringify(updateRaceExamples)}`)
  } finally {
    await sql.end({ timeout: 2 })
    disposable.stop()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
