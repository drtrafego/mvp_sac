import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import postgres from 'postgres'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const containerName = `recovery-leads-schema-${process.pid}`

function dockerAvailable() {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

async function freePort() {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('porta indisponível'))
      server.close(() => resolvePort(address.port))
    })
  })
}

async function startPostgres() {
  const port = await freePort()
  spawnSync('docker', ['rm', '-f', '-v', containerName], { stdio: 'ignore' })
  execFileSync('docker', [
    'run', '--rm', '-d', '--name', containerName,
    '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=test',
    '-p', `127.0.0.1:${port}:5432`, 'postgres:16-alpine',
  ], { stdio: 'ignore' })

  const url = `postgres://postgres:test@127.0.0.1:${port}/test`
  const deadline = Date.now() + 30_000
  let lastError: unknown
  while (Date.now() < deadline) {
    const probe = postgres(url, { max: 1, connect_timeout: 2 })
    try {
      await probe`select 1`
      await probe.end({ timeout: 1 })
      return { url, stop: () => spawnSync('docker', ['rm', '-f', '-v', containerName], { stdio: 'ignore' }) }
    } catch (error) {
      lastError = error
      await probe.end({ timeout: 1 }).catch(() => undefined)
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  spawnSync('docker', ['rm', '-f', '-v', containerName], { stdio: 'ignore' })
  throw new Error(`Postgres descartável não respondeu: ${String(lastError)}`)
}

test('0032 cria as colunas ausentes, é idempotente e mantém o tenant do lead', async (t) => {
  if (!dockerAvailable()) {
    t.skip('Docker não disponível')
    return
  }

  const disposable = await startPostgres()
  const sql = postgres(disposable.url)
  t.after(async () => {
    await sql.end({ timeout: 2 })
    disposable.stop()
  })

  await sql.unsafe(`
    CREATE TABLE companies (id integer PRIMARY KEY, slug text NOT NULL);
    CREATE TABLE settings (company_id integer NOT NULL, ai_agent_key text);
    CREATE TABLE recovery_leads (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE whatsapp_messages (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      lead_id integer,
      created_at timestamptz NOT NULL,
      channel text,
      direction text NOT NULL
    );
    INSERT INTO companies (id, slug) VALUES (1, 'tenant-one'), (2, 'tenant-two');
    INSERT INTO settings (company_id, ai_agent_key) VALUES (1, 'agent-one'), (2, 'agent-two');
    INSERT INTO recovery_leads (id, company_id) VALUES (1, 1), (2, 2), (3, 1);
    INSERT INTO whatsapp_messages (company_id, lead_id, created_at, channel, direction)
    VALUES
      (2, 1, '2026-10-01T00:00:00Z', 'whatsapp', 'inbound'),
      (1, 1, '2026-10-02T00:00:00Z', 'whatsapp', 'inbound'),
      (2, 2, '2026-10-03T00:00:00Z', 'instagram', 'inbound');
  `)

  const migration = readFileSync(resolve(root, 'drizzle/0032_first_human_message_metric.sql'), 'utf8')
  await sql.unsafe(migration)
  await sql.unsafe(migration)

  const columns = await sql<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'recovery_leads'
      AND column_name LIKE 'first_human_message_%'
    ORDER BY column_name
  `
  assert.deepEqual(columns.map((row) => row.column_name), [
    'first_human_message_agent_key',
    'first_human_message_at',
    'first_human_message_channel',
  ])

  const backfilled = await sql<{ company_id: number; first_human_message_channel: string; first_human_message_agent_key: string }[]>`
    SELECT company_id, first_human_message_channel, first_human_message_agent_key
    FROM recovery_leads
    ORDER BY id
  `
  assert.deepEqual(Array.from(backfilled), [
    { company_id: 1, first_human_message_channel: 'whatsapp', first_human_message_agent_key: 'agent-one' },
    { company_id: 2, first_human_message_channel: 'instagram', first_human_message_agent_key: 'agent-two' },
    { company_id: 1, first_human_message_channel: null, first_human_message_agent_key: null },
  ])

  await sql`
    INSERT INTO whatsapp_messages (company_id, lead_id, created_at, channel, direction)
    VALUES (2, 3, '2026-10-04T00:00:00Z', 'instagram', 'inbound')
  `
  const crossTenant = await sql`SELECT first_human_message_at FROM recovery_leads WHERE id = 3`
  assert.equal(crossTenant[0].first_human_message_at, null)

  await sql`
    INSERT INTO whatsapp_messages (company_id, lead_id, created_at, channel, direction)
    VALUES (1, 3, '2026-10-05T00:00:00Z', 'whatsapp', 'inbound')
  `
  const sameTenant = await sql`SELECT first_human_message_channel FROM recovery_leads WHERE id = 3`
  assert.equal(sameTenant[0].first_human_message_channel, 'whatsapp')

  const [index] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'recovery_leads_first_human_message_daily_idx'
    )
  `
  assert.equal(index.exists, true)
})
