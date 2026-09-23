import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../src/lib/db/schema'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'sync_agents_ctwa_multi_company_test'

function dockerAvailable(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

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
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' })
  const port = await freePort()
  execFileSync('docker', [
    'run', '--rm', '-d', '--name', CONTAINER_NAME,
    '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=test',
    '-p', `127.0.0.1:${port}:5432`, 'postgres:16-alpine',
  ])
  const url = `postgres://postgres:test@127.0.0.1:${port}/test`
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const probe = postgres(url, { max: 1, connect_timeout: 2 })
      await probe`select 1`
      await probe.end({ timeout: 1 })
      return { url, stop: () => { spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' }) } }
    } catch {
      await new Promise(resolve => setTimeout(resolve, 400))
    }
  }
  throw new Error('Postgres descartável não iniciou')
}

function applySchema(url: string) {
  execFileSync('pnpm', ['exec', 'drizzle-kit', 'push', '--force'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  })
}

async function createAgentSchema(sql: ReturnType<typeof postgres>, name: string) {
  await sql`create schema ${sql(name)}`
  await sql`create table ${sql(name)}.conversations (
    session_id text primary key, chat_id text, channel text, title text,
    started_at timestamp, ended_at timestamp, message_count integer
  )`
  await sql`create table ${sql(name)}.messages (
    id text primary key, session_id text, role text, content text,
    ts timestamp, platform_message_id text
  )`
  await sql`create table ${sql(name)}.crm_leads (
    id text primary key, name text, phone text, email text, notes text,
    campaign_source text, company text, value numeric, follow_up_date timestamp,
    follow_up_note text, status text, first_contact_at timestamp, created_at timestamp
  )`
}

async function setupSource(sql: ReturnType<typeof postgres>) {
  await sql`create table public.organizations (id text primary key, slug text, name text)`
  await sql`create table public.agents (
    id text primary key, organization_id text, slug text, schema_name text, name text,
    meta_phone_number_id text, meta_waba_id text, meta_token_env text, active boolean
  )`
  await sql`create table public.outreach_convos (
    id text primary key, agent_slug text, channel text, source text, lead_name text,
    lead_handle text, lead_company text, status text, last_at timestamp, msg_count integer
  )`
  await sql`create table public.outreach_msgs (
    id text primary key, convo_id text, direction text, status text,
    subject text, body text, sent_at timestamp
  )`
  await sql`create table public.ctwa_referrals (
    id text primary key, phone_norm text, source_id text, ad_name text,
    adset_name text, campaign_name text, ts bigint, synced_at timestamptz
  )`

  for (const name of ['drlucas', 'gramadoplazza', 'organicclinic']) await createAgentSchema(sql, name)

  await sql`insert into public.organizations (id, slug, name) values
    ('org-lucas', 'dr-lucas', 'Dr. Lucas'),
    ('org-gramado', 'gramado-plazza', 'Gramado Plaza'),
    ('org-organic', 'organic-clinic', 'Organic Clinic')`
  await sql`insert into public.agents (id, organization_id, slug, schema_name, name, active) values
    ('agent-lucas', 'org-lucas', 'drlucas', 'drlucas', 'Clara', true),
    ('agent-gramado', 'org-gramado', 'gramadoplazza', 'gramadoplazza', 'Gabi', true),
    ('agent-organic', 'org-organic', 'organicclinic', 'organicclinic', 'Olívia', true)`

  const lucasPhone = '5511999991001'
  const lucasNativePhone = '5511999991002'
  const gramadoPhone = '5554999992002'
  // Mesmo telefone do Gramado, mas conversa 22 dias antes do referral. Este é
  // o caso adversarial que o UPDATE global antigo marcava como anúncio.
  const organicPhone = gramadoPhone

  await sql`insert into drlucas.conversations values
    ('lucas-ctwa', ${lucasPhone}, 'whatsapp', 'Lucas CTWA', '2026-09-23 10:00:00', '2026-09-23 10:01:00', 1),
    ('lucas-native', ${lucasNativePhone}, 'whatsapp', 'Lucas UTM', '2026-09-23 12:00:00', '2026-09-23 12:01:00', 1)`
  await sql`insert into drlucas.messages values
    ('lm1', 'lucas-ctwa', 'user', 'Olá', '2026-09-23 10:00:00', null),
    ('lm2', 'lucas-native', 'user', 'Olá', '2026-09-23 12:00:00', null)`
  await sql`insert into drlucas.crm_leads (id, name, phone, campaign_source, first_contact_at, created_at) values
    ('crm-lucas-ctwa', 'Paciente CTWA', ${lucasPhone}, 'Anuncio', '2026-09-23 10:00:00', '2026-09-23 10:00:00'),
    ('crm-lucas-native', 'Paciente UTM', ${lucasNativePhone}, 'instagram_campaign_real', '2026-09-23 12:00:00', '2026-09-23 12:00:00')`

  await sql`insert into gramadoplazza.conversations values
    ('gramado-ctwa', ${gramadoPhone}, 'whatsapp', 'Reserva CTWA', '2026-09-23 11:00:00', '2026-09-23 11:01:00', 1)`
  await sql`insert into gramadoplazza.messages values
    ('gm1', 'gramado-ctwa', 'user', 'Quero reservar', '2026-09-23 11:00:00', null)`
  await sql`insert into gramadoplazza.crm_leads (id, name, phone, first_contact_at, created_at) values
    ('crm-gramado', 'Reserva CTWA', ${gramadoPhone}, '2026-09-23 11:00:00', '2026-09-23 11:00:00')`

  await sql`insert into organicclinic.conversations values
    ('organic-old', ${organicPhone}, 'whatsapp', 'Conversa orgânica antiga', '2026-09-01 11:00:00', '2026-09-01 11:01:00', 1)`
  await sql`insert into organicclinic.messages values
    ('om1', 'organic-old', 'user', 'Olá', '2026-09-01 11:00:00', null)`
  await sql`insert into organicclinic.crm_leads (id, name, phone, first_contact_at, created_at) values
    ('crm-organic', 'Contato Orgânico', ${organicPhone}, '2026-09-01 11:00:00', '2026-09-01 11:00:00')`

  await sql`insert into public.ctwa_referrals
    (id, phone_norm, source_id, campaign_name, adset_name, ad_name, ts, synced_at) values
    ('ctwa-lucas', ${lucasPhone}, 'ad-lucas', 'Campanha Lucas Real', 'Conjunto Lucas Real', 'Anúncio Lucas Real', 1790157600, '2026-09-23 10:00:00Z'),
    ('ctwa-gramado', ${gramadoPhone}, 'ad-gramado', 'Campanha Gramado Real', 'Conjunto Gramado Real', 'Anúncio Gramado Real', 1790161200, '2026-09-23 11:00:00Z')`
}

async function main() {
  if (!dockerAvailable()) throw new Error('Docker é obrigatório para este teste')
  const disposable = await startPostgres()
  const sql = postgres(disposable.url)
  try {
    applySchema(disposable.url)
    await setupSource(sql)
    const testDb = drizzle(sql, { schema })
    mock.module('@/lib/db', { namedExports: { db: testDb } })
    mock.module('@/lib/db/agents-db', {
      namedExports: {
        getAgentsDbUrl: async () => disposable.url,
        queryAgentsDb: async (query: string, params: unknown[] = []) => {
          try { return await sql.unsafe(query, params as never[]) }
          catch (error) { console.error('[source query]', error); return null }
        },
      },
    })

    const { syncAgentsAndCompanies } = await import('../src/lib/sync-agents')
    const report = await syncAgentsAndCompanies()
    assert.equal(report.ok, true)

    const rows = await sql`
      select c.slug, l.phone, l.tracking_source, l.utm_campaign, l.adset_name, l.ad_name
      from recovery_leads l join companies c on c.id=l.company_id order by c.slug,l.phone
    `
    const byKey = new Map(rows.map(row => [`${row.slug}:${row.phone}`, row]))
    const lucasCtwa = byKey.get('drlucas:5511999991001')!
    const lucasNative = byKey.get('drlucas:5511999991002')!
    const gramado = byKey.get('gramado-plaza:5554999992002')!
    const organic = byKey.get('organicclinic:5554999992002')!

    await test('Dr. Lucas recebe campanha, conjunto e anúncio CTWA reais', () => {
      assert.equal(lucasCtwa.tracking_source, 'meta_ads')
      assert.equal(lucasCtwa.utm_campaign, 'Campanha Lucas Real')
      assert.equal(lucasCtwa.adset_name, 'Conjunto Lucas Real')
      assert.equal(lucasCtwa.ad_name, 'Anúncio Lucas Real')
    })
    await test('Gramado Plaza recebe campanha, conjunto e anúncio CTWA reais', () => {
      assert.equal(gramado.tracking_source, 'meta_ads')
      assert.equal(gramado.utm_campaign, 'Campanha Gramado Real')
      assert.equal(gramado.adset_name, 'Conjunto Gramado Real')
      assert.equal(gramado.ad_name, 'Anúncio Gramado Real')
    })
    await test('campaign_source nativo substitui a origem genérica do Dr. Lucas', () => {
      assert.equal(lucasNative.tracking_source, 'instagram_campaign_real')
    })
    await test('empresa sem CTWA real não ganha falso positivo nem com telefone igual', () => {
      assert.equal(organic.tracking_source, 'agente_ia')
      assert.equal(organic.utm_campaign, null)
      assert.equal(organic.adset_name, null)
      assert.equal(organic.ad_name, null)
    })
    await test('cada empresa ativa mantém cursor CTWA próprio', async () => {
      const cursors = await sql`select count(distinct company_id)::int n from sync_cursors where source='ctwa_referrals'`
      assert.equal(cursors[0].n, 3)
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
