// Teste de regressão do bug de paginação em src/lib/sync-agents.ts.
//
// Bug real (22/09/2026): os blocos de fonte externa usavam
// "ORDER BY ... DESC LIMIT 300" sem cursor. Como o cron roda a mesma função
// a cada 10 minutos, uma fonte com mais de 300 linhas relia sempre as 300
// mais recentes e nunca alcançava o histórico antigo.
//
// Este teste usa Postgres Docker real para o banco local e para a fonte dos
// agentes. O mock de queryAgentsDb executa as queries reais contra tabelas de
// fonte criadas no Postgres; não devolve fixture filtrada em memória. Roda a
// sync 3 vezes simulando o cron:
//   1. importa as 300 conversas mais recentes e grava os cursores.
//   2. importa as 200 conversas antigas restantes via backfill.
//   3. não duplica nada.
//
// Uso: npx tsx --experimental-test-module-mocks --test scripts/sync-agents-pagination-backfill.test.ts

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../src/lib/db/schema'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'sync_agents_pagination_backfill_test'
const SOURCE_SCHEMA = 'agent_sync_pagination'
const TOTAL_CONVERSATIONS = 500
const CTWA_1201_PHONE = '5511999991201'
const CTWA_1201_CAMPAIGN = 'ag [ENG] [WHATSAPP] 23/09'
const CTWA_1201_AD = 'ag [WHATSAPP] img-42-sem-resposta 23/09'

function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['info'], { stdio: 'ignore' })
  return r.status === 0
}

async function pickFreePortAsync(): Promise<number> {
  const net = await import('node:net')
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object' && addr) {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('não deu pra alocar porta livre')))
      }
    })
  })
}

async function startDisposablePostgres(): Promise<{ url: string; stop: () => void }> {
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' })
  const port = await pickFreePortAsync()
  console.log(`[setup] subindo postgres:16-alpine descartável na porta ${port} (container ${CONTAINER_NAME})...`)
  execFileSync('docker', [
    'run', '--rm', '-d',
    '--name', CONTAINER_NAME,
    '-e', 'POSTGRES_PASSWORD=test',
    '-e', 'POSTGRES_DB=test',
    '-p', `127.0.0.1:${port}:5432`,
    'postgres:16-alpine',
  ])

  const url = `postgres://postgres:test@127.0.0.1:${port}/test`

  const deadline = Date.now() + 30_000
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    try {
      const probe = postgres(url, { max: 1, connect_timeout: 2 })
      await probe`select 1`
      await probe.end({ timeout: 1 })
      lastErr = null
      break
    } catch (err) {
      lastErr = err
      await new Promise(r => setTimeout(r, 500))
    }
  }
  if (lastErr) throw new Error(`postgres descartável não respondeu a tempo: ${String(lastErr)}`)

  return {
    url,
    stop: () => {
      console.log('[teardown] derrubando container descartável...')
      spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' })
    },
  }
}

function applyRealSchema(databaseUrl: string) {
  console.log('[setup] aplicando o schema real do projeto via drizzle-kit push...')
  execFileSync('npx', ['drizzle-kit', 'push', '--force'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  })
}

async function setupRealAgentsSource(sql: ReturnType<typeof postgres>) {
  console.log(`[setup] criando fonte real com ${TOTAL_CONVERSATIONS} conversas...`)

  await sql`
    create table public.organizations (
      id text primary key,
      slug text,
      name text
    )
  `
  await sql`
    create table public.agents (
      id text primary key,
      organization_id text,
      slug text,
      schema_name text,
      name text,
      meta_phone_number_id text,
      meta_waba_id text,
      meta_token_env text,
      active boolean default true
    )
  `
  await sql`create schema ${sql(SOURCE_SCHEMA)}`
  await sql`
    create table ${sql(SOURCE_SCHEMA)}.conversations (
      session_id text primary key,
      chat_id text,
      channel text,
      title text,
      started_at timestamp,
      ended_at timestamp,
      message_count integer
    )
  `
  await sql`
    create table ${sql(SOURCE_SCHEMA)}.messages (
      id integer primary key,
      session_id text,
      role text,
      content text,
      ts timestamp,
      platform_message_id text
    )
  `
  await sql`
    create table public.outreach_convos (
      id text primary key,
      agent_slug text,
      channel text,
      source text,
      lead_name text,
      lead_handle text,
      lead_company text,
      status text,
      last_at timestamp,
      msg_count integer
    )
  `
  await sql`
    create table public.outreach_msgs (
      id text primary key,
      convo_id text,
      direction text,
      status text,
      subject text,
      body text,
      sent_at timestamp
    )
  `
  await sql`
    create table public.leads (
      id text primary key,
      organization_id text,
      whatsapp text,
      email text,
      name text,
      company text,
      notes text,
      value numeric,
      status text,
      follow_up_date timestamp,
      follow_up_note text,
      campaign_source text,
      utm_source text,
      utm_medium text,
      utm_campaign text,
      utm_content text,
      utm_term text,
      ai_agent text,
      created_at timestamp,
      first_contact_at timestamp
    )
  `
  await sql`
    create table public.ctwa_referrals (
      id text primary key,
      phone_norm text,
      source_id text,
      ad_name text,
      adset_name text,
      campaign_name text,
      headline text,
      body text,
      source_url text,
      ctwa_clid text,
      ts bigint,
      synced_at timestamptz default now()
    )
  `

  await sql`
    insert into public.organizations (id, slug, name)
    values ('org-autonomia', 'autonomia', 'AutonomIA')
  `
  await sql`
    insert into public.agents (id, organization_id, slug, schema_name, name, active)
    values ('agent-autonomia', 'org-autonomia', 'autonomia', ${SOURCE_SCHEMA}, 'Nina', true)
  `

  const conversations = Array.from({ length: TOTAL_CONVERSATIONS }, (_, idx) => {
    const n = idx + 1
    const at = new Date(Date.UTC(2026, 8, 1, 0, n, 0)).toISOString()
    return {
      session_id: `session-${String(n).padStart(3, '0')}`,
      chat_id: `5511999${String(n).padStart(6, '0')}`,
      channel: 'whatsapp',
      title: `Conversa ${n}`,
      started_at: at,
      ended_at: at,
      message_count: 1,
    }
  })

  const messages = conversations.map((conversation, idx) => ({
    id: idx + 1,
    session_id: conversation.session_id,
    role: 'user',
    content: `Mensagem ${idx + 1}`,
    ts: conversation.ended_at,
    platform_message_id: null as string | null,
  }))

  await sql`insert into ${sql(SOURCE_SCHEMA)}.conversations ${sql(conversations)}`
  await sql`insert into ${sql(SOURCE_SCHEMA)}.messages ${sql(messages)}`
  await sql`
    insert into public.ctwa_referrals (
      id, phone_norm, source_id, ad_name, adset_name, campaign_name,
      headline, body, source_url, ctwa_clid, ts, synced_at
    )
    values (
      '5511999991201_1790098806_120248295700610686',
      ${CTWA_1201_PHONE},
      '120248295700610686',
      ${CTWA_1201_AD},
      '[ENG] [WHATSAPP] [BR] Advantage+ 23/09',
      ${CTWA_1201_CAMPAIGN},
      'Headline teste CTWA',
      'Body teste CTWA',
      'https://fb.me/teste-ctwa',
      'ctwa-clid-teste',
      1790098806,
      '2026-09-22T19:00:41Z'
    )
  `
}

async function seedLocalCtwaLeadFixtures(sql: ReturnType<typeof postgres>) {
  const [company] = await sql`
    insert into companies (name, slug, plan)
    values ('AutonomIA', 'autonomia', 'pro')
    on conflict (slug) do update set name = excluded.name
    returning id
  `

  await sql`
    insert into recovery_leads (company_id, platform, event_type, phone, name, status)
    values
      (${company.id}, 'manual', 'manual', ${CTWA_1201_PHONE}, 'Lead CTWA 1201', 'pending'),
      (${company.id}, 'manual', 'manual', '5511999997777', 'Lead sem CTWA', 'pending')
  `
}

async function reproduceOldCtwaCreatedAtBug(sql: ReturnType<typeof postgres>): Promise<unknown> {
  try {
    await sql.unsafe(`
      select id, phone_norm, campaign_name, ad_name, created_at,
             coalesce(created_at, '1970-01-01T00:00:00.000Z'::timestamp) as __sync_sort_at,
             id::text as __sync_cursor_id
      from public.ctwa_referrals
      where phone_norm is not null and length(phone_norm) >= 8
      order by coalesce(created_at, '1970-01-01T00:00:00.000Z'::timestamp) desc, id::text desc
      limit 300
    `)
    return null
  } catch (err) {
    return err
  }
}

async function localCounts(sql: ReturnType<typeof postgres>) {
  const externalIdPattern = `agent_${SOURCE_SCHEMA}_%`
  const [leadCount] = await sql`
    select count(*)::int as total, count(distinct phone)::int as distinct_phone
    from recovery_leads
    where platform = 'sac' and event_type = 'atendimento_ia'
  `
  const [messageCount] = await sql`
    select count(*)::int as total, count(distinct external_id)::int as distinct_external_id
    from whatsapp_messages
    where external_id like ${externalIdPattern}
  `
  const duplicateMessages = await sql`
    select external_id, count(*)::int as total
    from whatsapp_messages
    where external_id like ${externalIdPattern}
    group by external_id
    having count(*) > 1
  `
  return {
    leads: Number(leadCount.total),
    distinctPhones: Number(leadCount.distinct_phone),
    messages: Number(messageCount.total),
    distinctMessageExternalIds: Number(messageCount.distinct_external_id),
    duplicateMessages: duplicateMessages.length,
  }
}

async function main() {
  if (!dockerAvailable()) {
    console.error('Docker não disponível: este teste precisa de um Postgres descartável real.')
    process.exitCode = 1
    return
  }

  const disposable = await startDisposablePostgres()
  const sql = postgres(disposable.url)

  try {
    applyRealSchema(disposable.url)

    const testDb = drizzle(sql, { schema })

    await setupRealAgentsSource(sql)
    await seedLocalCtwaLeadFixtures(sql)
    const oldCtwaBugError = await reproduceOldCtwaCreatedAtBug(sql)

    mock.module('@/lib/db', {
      namedExports: { db: testDb },
    })

    mock.module('@/lib/db/agents-db', {
      namedExports: {
      getAgentsDbUrl: async () => disposable.url,
      queryAgentsDb: async (query: string, params: unknown[] = []) => {
        try {
          const unsafeParams = params as Parameters<typeof sql.unsafe>[1]
          return await sql.unsafe(query, unsafeParams)
        } catch (err) {
            console.error('[mock Agents DB Error]', err)
            return null
          }
        },
      },
    })

    const { syncAgentsAndCompanies } = await import('../src/lib/sync-agents')

    const report1 = await syncAgentsAndCompanies()
    const counts1 = await localCounts(sql)
    const [ctwaLead1201AfterSync] = await sql`
      select tracking_source, utm_campaign, adset_name, ad_name
      from recovery_leads
      where phone = ${CTWA_1201_PHONE}
    `
    const [leadWithoutCtwaAfterSync] = await sql`
      select tracking_source, utm_campaign
      from recovery_leads
      where phone = '5511999997777'
    `

    await test('CTWA: query antiga com created_at reproduz o bug antes do fix', () => {
      assert.ok(oldCtwaBugError, 'a query antiga deveria falhar porque public.ctwa_referrals não tem created_at')
      assert.match(String(oldCtwaBugError), /created_at/)
    })

    await test('1ª execução do cron importa só o primeiro lote de 300 e grava cursor', async () => {
      assert.equal(report1.ok, true)
      assert.equal(report1.messagesImported, 300)
      assert.equal(counts1.leads, 300)
      assert.equal(counts1.messages, 300)

      const cursors = await sql`
        select newest_synced_at, newest_synced_id, backfill_before_at, backfill_before_id
        from sync_cursors
        where source = 'agent_conversations' and source_key = ${SOURCE_SCHEMA}
      `
      assert.equal(cursors.length, 1, 'cursor de conversas deveria existir após a 1ª rodada')
      assert.ok(cursors[0].newest_synced_at, 'newest_synced_at deveria ser preenchido')
      assert.ok(cursors[0].backfill_before_at, 'backfill_before_at deveria ser preenchido')
    })

    await test('CTWA: telefone real sufixo 1201 passa a ser marcado como meta_ads', () => {
      assert.ok(ctwaLead1201AfterSync, 'lead 1201 deveria existir no banco local de teste')
      assert.equal(ctwaLead1201AfterSync.tracking_source, 'meta_ads')
      assert.equal(ctwaLead1201AfterSync.utm_campaign, CTWA_1201_CAMPAIGN)
      assert.equal(ctwaLead1201AfterSync.adset_name, '[ENG] [WHATSAPP] [BR] Advantage+ 23/09')
      assert.equal(ctwaLead1201AfterSync.ad_name, CTWA_1201_AD)
      assert.ok(
        report1.details.some((detail: string) => detail.includes('leads identificados como Anúncios Meta')),
        'relatório deveria registrar atualização CTWA'
      )
    })

    await test('CTWA: lead sem referral continua sem alteração', () => {
      assert.ok(leadWithoutCtwaAfterSync, 'lead sem CTWA deveria existir no banco local de teste')
      assert.equal(leadWithoutCtwaAfterSync.tracking_source, null)
      assert.equal(leadWithoutCtwaAfterSync.utm_campaign, null)
    })

    const report2 = await syncAgentsAndCompanies()
    const counts2 = await localCounts(sql)

    await test('2ª execução faz backfill do histórico antigo e chega às 500 conversas', () => {
      assert.equal(report2.ok, true)
      assert.equal(report2.messagesImported, 200)
      assert.equal(counts2.leads, TOTAL_CONVERSATIONS)
      assert.equal(counts2.messages, TOTAL_CONVERSATIONS)
      assert.equal(counts2.distinctPhones, TOTAL_CONVERSATIONS)
      assert.equal(counts2.distinctMessageExternalIds, TOTAL_CONVERSATIONS)
      assert.equal(counts2.duplicateMessages, 0)
    })

    const report3 = await syncAgentsAndCompanies()
    const counts3 = await localCounts(sql)

    await test('3ª execução não duplica nada depois que o histórico esgotou', () => {
      assert.equal(report3.ok, true)
      assert.equal(report3.messagesImported, 0)
      assert.equal(counts3.leads, TOTAL_CONVERSATIONS)
      assert.equal(counts3.messages, TOTAL_CONVERSATIONS)
      assert.equal(counts3.distinctPhones, TOTAL_CONVERSATIONS)
      assert.equal(counts3.distinctMessageExternalIds, TOTAL_CONVERSATIONS)
      assert.equal(counts3.duplicateMessages, 0)
    })

    await sql`drop table public.ctwa_referrals`
    const reportWithoutCtwaTable = await syncAgentsAndCompanies()
    const [leadWithoutCtwaTable] = await sql`
      select tracking_source, utm_campaign
      from recovery_leads
      where phone = '5511999997777'
    `

    await test('CTWA: tabela opcional ausente não quebra o sync', () => {
      assert.equal(reportWithoutCtwaTable.ok, true)
      assert.equal(leadWithoutCtwaTable.tracking_source, null)
      assert.equal(leadWithoutCtwaTable.utm_campaign, null)
    })
  } finally {
    await sql.end({ timeout: 2 })
    disposable.stop()
  }
}

main()
  .then(() => {
    console.log('\nOK: paginação/backfill incremental do sync-agents validado contra Postgres real.')
  })
  .catch(err => {
    console.error('Erro fatal no teste de paginação/backfill do sync-agents:', err)
    process.exitCode = 1
  })
