// Regressão do histórico aberto do Inbox. Usa Postgres 16 descartável e o
// loader real para provar paginação sem teto, ordem estável e custo do lote
// inicial numa conversa com milhares de mensagens.

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../src/lib/db/schema'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'inbox_message_history_performance_test'
const TOTAL = 5_005

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
      .values({ name: 'Carga Histórico', slug: 'carga-historico' }).returning()
    const [lead] = await testDb.insert(schema.recoveryLeads).values({
      companyId: company.id,
      phone: '5511999990000',
      name: 'Lead de carga',
      eventType: 'atendimento',
      platform: 'sac',
      agentConversationId: 'session-volume',
      agentCostUsd: '1.23456789',
      agentInputTokens: 987_654,
      agentOutputTokens: 123_456,
      agentSyncedAt: new Date('2026-09-23T12:00:00Z'),
    }).returning()

    await client.unsafe(`
      insert into whatsapp_messages
        (company_id, lead_id, phone, direction, content, sent_by, reasoning, sent_email, created_at)
      select $1, $2, $3,
             case when gs % 2 = 0 then 'inbound' else 'outbound' end,
             'Mensagem ' || gs || repeat(' x', 20),
             case when gs % 2 = 0 then 'user' else 'bot' end,
             case when gs = ${TOTAL} then 'raciocínio auditável' else null end,
             case when gs = ${TOTAL - 2} then 'corpo do e-mail auditável' else null end,
             timestamp '2026-01-01 00:00:00' + gs * interval '1 second'
      from generate_series(1, ${TOTAL}) gs
    `, [company.id, lead.id, lead.phone])
    await client`analyze whatsapp_messages`

    const { loadInboxMessagePage, INBOX_MESSAGE_PAGE_SIZE } = await import('../src/lib/inbox-messages')

    await test('primeiro lote traz só as mensagens mais recentes com metadados', async () => {
      const started = performance.now()
      const page = await loadInboxMessagePage({ companyId: company.id, leadId: lead.id, phone: lead.phone })
      const elapsedMs = performance.now() - started
      const bytes = JSON.stringify(page).length
      assert.equal(page.messages.length, INBOX_MESSAGE_PAGE_SIZE)
      assert.equal(page.messages.at(-1)?.content?.startsWith(`Mensagem ${TOTAL}`), true)
      assert.equal(page.messages.at(-1)?.reasoning, 'raciocínio auditável')
      assert.equal(page.messages.at(-3)?.sentEmail, 'corpo do e-mail auditável')
      assert.equal(page.hasMore, true)
      assert.ok(page.nextCursor)
      assert.ok(elapsedMs < 1_500, `primeiro lote levou ${elapsedMs.toFixed(1)}ms`)
      assert.ok(bytes < 100_000, `payload inicial inesperado: ${bytes} bytes`)
      console.log(`[medição] ${TOTAL} mensagens: lote recente=${elapsedMs.toFixed(1)}ms, bytes=${bytes}`)
    })

    await test('cursor percorre milhares sem teto, duplicação ou lacuna', async () => {
      const ids: number[] = []
      let before: string | null = null
      do {
        const page = await loadInboxMessagePage({ companyId: company.id, leadId: lead.id, phone: lead.phone, before })
        ids.unshift(...page.messages.map(message => message.id))
        before = page.nextCursor
        if (!page.hasMore) assert.equal(before, null)
      } while (before)

      assert.equal(ids.length, TOTAL)
      assert.equal(new Set(ids).size, TOTAL)
      assert.deepEqual(ids, [...ids].sort((a, b) => a - b))
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
