// Regressão do travamento do Inbox de 23/09/2026.
// Sobe Postgres real descartável, cria 2.405 conversas e chama o loader REAL
// usado pelo layout e por /api/inbox. Prova que o primeiro lote fica limitado
// a 75, que o cursor não duplica/pula linhas e que não existe teto total.

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../src/lib/db/schema'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'inbox_pagination_performance_test'
const TOTAL = 2_405

function dockerAvailable(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

async function freePort(): Promise<number> {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('porta livre indisponível'))
      server.close(() => resolve(address.port))
    })
  })
}

async function startPostgres(): Promise<{ url: string; stop: () => void }> {
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' })
  const port = await freePort()
  execFileSync('docker', [
    'run', '--rm', '-d', '--name', CONTAINER_NAME,
    '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=test',
    '-p', `127.0.0.1:${port}:5432`, 'postgres:16-alpine',
  ], { stdio: 'ignore' })
  const url = `postgres://postgres:test@127.0.0.1:${port}/test`
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const probe = postgres(url, { max: 1, connect_timeout: 2 })
      await probe`select 1`
      await probe.end({ timeout: 1 })
      return { url, stop: () => { spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' }) } }
    } catch {
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  }
  throw new Error('Postgres descartável não respondeu em 30s')
}

async function main() {
  if (!dockerAvailable()) throw new Error('Docker é obrigatório para este teste')
  const disposable = await startPostgres()
  try {
    execFileSync('pnpm', ['exec', 'drizzle-kit', 'push', '--force'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DATABASE_URL: disposable.url },
      stdio: 'ignore',
    })

    const client = postgres(disposable.url, { max: 10 })
    const testDb = drizzle(client, { schema })
    mock.module('@/lib/db', { namedExports: { db: testDb } })

    const [company] = await testDb.insert(schema.companies)
      .values({ name: 'Carga Inbox', slug: 'carga-inbox' }).returning()

    await client.unsafe(`
      insert into recovery_leads
        (company_id, phone, name, event_type, status, channel, bot_paused,
         created_at, updated_at, last_action_at)
      select $1,
             '5511' || lpad(gs::text, 9, '0'),
             'Lead ' || gs,
             'atendimento', 'in_conversation', 'whatsapp', false,
             timestamp '2026-09-01 00:00:00' + gs * interval '1 second',
             timestamp '2026-09-01 00:00:00' + gs * interval '1 second',
             timestamp '2026-09-01 00:00:00' + gs * interval '1 second'
      from generate_series(1, ${TOTAL}) gs
    `, [company.id])
    await client.unsafe(`
      insert into whatsapp_messages (company_id, lead_id, phone, direction, content, created_at)
      select company_id, id, phone,
             case when id % 2 = 0 then 'inbound' else 'outbound' end,
             'Mensagem do ' || name,
             last_action_at
      from recovery_leads where company_id = $1
    `, [company.id])

    const { loadInboxPage, INBOX_PAGE_SIZE } = await import('../src/lib/inbox-conversations')

    await test('primeiro lote é pequeno e rápido mesmo com milhares de conversas', async () => {
      const started = performance.now()
      const page = await loadInboxPage({ companyId: company.id })
      const elapsedMs = performance.now() - started
      assert.equal(page.conversations.length, INBOX_PAGE_SIZE)
      assert.equal(page.hasMore, true)
      assert.ok(page.nextCursor)
      assert.ok(elapsedMs < 1_500, `primeiro lote levou ${elapsedMs.toFixed(1)}ms`)
      assert.ok(JSON.stringify(page).length < 100_000, 'lote inicial não deve recriar payload megabyte')
      console.log(`[medição] ${TOTAL} conversas: primeiro lote=${elapsedMs.toFixed(1)}ms, bytes=${JSON.stringify(page).length}`)
    })

    await test('cursor percorre tudo sem teto, duplicação ou lacuna', async () => {
      const ids: number[] = []
      let cursor: string | null = null
      do {
        const page = await loadInboxPage({ companyId: company.id, cursor })
        ids.push(...page.conversations.map(conversation => conversation.id))
        cursor = page.nextCursor
        if (!page.hasMore) assert.equal(cursor, null)
      } while (cursor)

      assert.equal(ids.length, TOTAL)
      assert.equal(new Set(ids).size, TOTAL)
      assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'ordem deve ser estável por atividade e id')
    })

    await client.end({ timeout: 2 })
  } finally {
    disposable.stop()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
