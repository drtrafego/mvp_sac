// Diagnóstico local do gargalo do Inbox. Usa somente Postgres descartável.
// Não lê nem escreve a base de produção e não chama nenhum transporte Hermes.

import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../src/lib/db/schema'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'inbox_tenant_performance_test'
const LUCAS_LEADS = 253
const GRAMADO_LEADS = 5_096
const GRAMADO_MESSAGES_PER_LEAD = 15

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
  spawnSync('docker', ['rm', '-f', '-v', CONTAINER_NAME], { stdio: 'ignore' })
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
      return { url, stop: () => { spawnSync('docker', ['rm', '-f', '-v', CONTAINER_NAME], { stdio: 'ignore' }) } }
    } catch {
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  }
  throw new Error('Postgres descartável não respondeu em 30s')
}

async function main() {
  if (!dockerAvailable()) {
    console.error('Docker não disponível: diagnóstico de carga não executado.')
    process.exitCode = 1
    return
  }

  const disposable = await startPostgres()
  try {
    execFileSync('pnpm', ['exec', 'drizzle-kit', 'push', '--force'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DATABASE_URL: disposable.url },
      stdio: 'ignore',
    })

    let queryCount = 0
    const client = postgres(disposable.url, {
      max: 1,
      debug: () => { queryCount++ },
    })
    const testDb = drizzle(client, { schema })
    mock.module('@/lib/db', { namedExports: { db: testDb } })

    const [lucas] = await testDb.insert(schema.companies)
      .values({ name: 'Dr Lucas carga', slug: 'drlucas-carga' }).returning()
    const [gramado] = await testDb.insert(schema.companies)
      .values({ name: 'Gramado carga', slug: 'gramado-plaza-carga' }).returning()

    await client.unsafe(`
      insert into recovery_leads
        (company_id, phone, name, event_type, status, channel, bot_paused,
         created_at, updated_at, last_action_at)
      select $1,
             '5511' || lpad(gs::text, 9, '0'),
             'Lucas ' || gs,
             'atendimento', 'in_conversation', 'whatsapp', false,
             timestamp '2026-09-01 00:00:00' + gs * interval '1 second',
             timestamp '2026-09-01 00:00:00' + gs * interval '1 second',
             timestamp '2026-09-01 00:00:00' + gs * interval '1 second'
      from generate_series(1, ${LUCAS_LEADS}) gs
    `, [lucas.id])
    await client.unsafe(`
      insert into recovery_leads
        (company_id, phone, name, event_type, status, channel, bot_paused,
         created_at, updated_at, last_action_at)
      select $1,
             '5554' || lpad(gs::text, 9, '0'),
             'Gramado ' || gs,
             'atendimento', 'in_conversation', 'whatsapp', false,
             timestamp '2026-09-01 00:00:00' + gs * interval '1 second',
             timestamp '2026-09-01 00:00:00' + gs * interval '1 second',
             timestamp '2026-09-01 00:00:00' + gs * interval '1 second'
      from generate_series(1, ${GRAMADO_LEADS}) gs
    `, [gramado.id])

    await client.unsafe(`
      insert into whatsapp_messages
        (company_id, lead_id, phone, direction, content, channel, created_at)
      select l.company_id, l.id, l.phone,
             case when gs = ${GRAMADO_MESSAGES_PER_LEAD} then 'inbound' else 'outbound' end,
             'Mensagem ' || gs || ' de ' || l.name,
             'whatsapp',
             l.last_action_at + gs * interval '1 second'
      from recovery_leads l
      cross join lateral generate_series(
        1,
        case when l.company_id = ${gramado.id} then ${GRAMADO_MESSAGES_PER_LEAD} else 1 end
      ) gs;
    `)
    await client.unsafe('set statement_timeout = 5000')

    const indexRows = await client.unsafe(`
      select indexname
      from pg_indexes
      where tablename = 'whatsapp_messages'
        and indexname like '%channel_phone_digits%'
    `)
    console.log(JSON.stringify({ visibilityIndex: indexRows }, null, 2))

    const { loadInboxPage, INBOX_PAGE_SIZE } = await import('../src/lib/inbox-conversations')
    const metrics: Record<string, { ms: number; queries: number; bytes: number; rows: number; hasMore: boolean }> = {}

    for (const [name, companyId] of [['drlucas', lucas.id], ['gramado-plaza', gramado.id]] as const) {
      queryCount = 0
      const started = performance.now()
      const page = await loadInboxPage({ companyId })
      metrics[name] = {
        ms: performance.now() - started,
        queries: queryCount,
        bytes: Buffer.byteLength(JSON.stringify(page)),
        rows: page.conversations.length,
        hasMore: page.hasMore,
      }
      assert.equal(page.conversations.length, INBOX_PAGE_SIZE)
      assert.equal(page.hasMore, true)
    }

    const gramadoPage = await loadInboxPage({ companyId: gramado.id })
    queryCount = 0
    const started = performance.now()
    const gramadoSecondPage = await loadInboxPage({ companyId: gramado.id, cursor: gramadoPage.nextCursor })
    const secondPageMs = performance.now() - started
    const secondPageQueries = queryCount
    const totalGramadoPages = Math.ceil(GRAMADO_LEADS / INBOX_PAGE_SIZE)

    console.log(JSON.stringify({
      dataset: {
        drlucasLeads: LUCAS_LEADS,
        gramadoLeads: GRAMADO_LEADS,
        gramadoMessages: GRAMADO_LEADS * GRAMADO_MESSAGES_PER_LEAD,
        pageSize: INBOX_PAGE_SIZE,
      },
      firstPage: metrics,
      pagination: {
        firstPageHasCursor: Boolean(gramadoPage.nextCursor),
        secondPageRows: gramadoSecondPage.conversations.length,
        secondPageQueries,
        gramadoExpectedPages: totalGramadoPages,
        gramadoSecondPageMs: Number(secondPageMs.toFixed(1)),
      },
      routeOverhead: {
        unauthenticatedApi: 'middleware returns 401 JSON before DB route',
        authenticatedInboxInitialServerLoad: 'auth + company + 4 sidebar reads + settings + 4 Inbox reads',
        authenticatedApiRefetch: 'settings + 4 Inbox reads',
      },
    }, null, 2))

    await client.end({ timeout: 2 })
  } finally {
    disposable.stop()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
