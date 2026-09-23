// Teste de regressão do bug "channel hardcoded 'whatsapp'" no bloco 5
// (Sincroniza novos Leads do CRM em BATCH) de src/lib/sync-agents.ts.
//
// Contexto: o Gastão reportou que os leads da campanha da AutonomIA estavam
// "todos errados" e "o filtro de origem não funciona". Causa raiz: o INSERT
// de leads novos vindos de public.leads (CRM) gravava sempre channel=
// 'whatsapp', mesmo quando o lead só tinha e-mail (sem telefone nenhum). Como
// inbox-channel-filter.ts e origins.ts usam essa coluna `channel` pra decidir
// a subcategoria dentro de "Mineração" (E-mail vs WhatsApp vs Instagram), todo
// lead de mineração da AutonomIA aparecia como WhatsApp no Inbox/Origens,
// mesmo os que só tinham e-mail.
//
// Fix: channel = cleanPhone ? 'whatsapp' : 'email' (mesma convenção que o
// bloco 4 já usa, `oc.channel || (isEmail ? 'email' : 'whatsapp')`).
//
// Este teste sobe um Postgres DESCARTÁVEL de verdade (mesmo padrão de
// scripts/hermes-conversion-webhook.test.ts), aplica o schema real via
// drizzle-kit push, mocka '@/lib/db' (db real contra o Postgres descartável)
// e '@/lib/db/agents-db' (queryAgentsDb devolve fixtures de CRM em memória,
// sem precisar de um segundo Postgres pro "Agents DB"), e roda
// syncAgentsAndCompanies() de verdade.
//
// Casos cobertos (pedidos na tarefa):
//   (a) lead com telefone e sem e-mail -> channel='whatsapp'
//   (b) lead com e-mail e sem telefone -> channel='email' (o bug corrigido)
//   (c) lead com os dois -> channel='whatsapp' (cleanPhone é checado primeiro
//       na condição; não é bug novo, é o comportamento já existente da
//       lógica de match/dedup do restante do arquivo, só documentado aqui)
//
// Uso: npx tsx --experimental-test-module-mocks --test scripts/sync-agents-crm-channel.test.ts

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'sync_agents_crm_channel_test'

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

// Fixtures de autonomia.crm_leads (CRM/Agents DB), no formato normalizado que
// o SELECT dinâmico por schema devolve.
const CRM_LEADS_FIXTURE = [
  {
    id: 'crm-1',
    organization_id: 'org-1',
    whatsapp: '11988887777',
    email: null,
    name: 'Lead Só WhatsApp',
    company: null,
    notes: null,
    value: null,
    status: 'new',
    follow_up_date: null,
    follow_up_note: null,
    campaign_source: null,
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
    ai_agent: 'Nina',
    created_at: '2026-09-22T10:00:00Z',
    first_contact_at: null,
  },
  {
    id: 'crm-2',
    organization_id: 'org-1',
    whatsapp: null,
    email: 'lead.so.email@exemplo.com',
    name: 'Lead Só E-mail',
    company: null,
    notes: null,
    value: null,
    status: 'new',
    follow_up_date: null,
    follow_up_note: null,
    campaign_source: null,
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
    ai_agent: 'Nina',
    created_at: '2026-09-22T10:05:00Z',
    first_contact_at: null,
  },
  {
    id: 'crm-3',
    organization_id: 'org-1',
    whatsapp: '11977776666',
    email: 'lead.completo@exemplo.com',
    name: 'Lead WhatsApp e E-mail',
    company: null,
    notes: null,
    value: null,
    status: 'new',
    follow_up_date: null,
    follow_up_note: null,
    campaign_source: null,
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
    ai_agent: 'Nina',
    created_at: '2026-09-22T10:10:00Z',
    first_contact_at: null,
  },
]

async function main() {
  if (!dockerAvailable()) {
    console.error('Docker não disponível: este teste precisa de um Postgres descartável real.')
    process.exitCode = 1
    return
  }

  const disposable = await startDisposablePostgres()
  applyRealSchema(disposable.url)

  const sql = postgres(disposable.url)
  const testDb = drizzle(sql, { schema })

  // ─── Mocks (precisam ser registrados ANTES do primeiro import dinâmico) ───
  mock.module('@/lib/db', {
    namedExports: { db: testDb },
  })

  // queryAgentsDb é a ÚNICA porta de saída pro "Agents DB" (banco separado,
  // schema-per-tenant). Mockamos por conteúdo da query (substring), igual um
  // fake de banco em memória: cada bloco de sync-agents.ts manda uma query
  // reconhecível (public.agents, information_schema.columns,
  // public.outreach_convos, public.outreach_msgs, <schema>.crm_leads,
  // public.ctwa_referrals). Blocos não relevantes pro bug (agentes/outreach/
  // ctwa) devolvem vazio, então só o bloco 5 (CRM) tem efeito neste teste.
  mock.module('@/lib/db/agents-db', {
    namedExports: {
      getAgentsDbUrl: async () => 'postgres://fake-agents-db-url/test',
      queryAgentsDb: async (query: string, params: unknown[] = []) => {
        if (query.includes('from public.agents')) {
          return [
            {
              id: 'agent-1',
              organization_id: 'org-1',
              org_slug: 'autonomia',
              org_name: 'AutonomIA',
              slug: 'autonomia',
              schema_name: 'autonomia',
              name: 'Nina',
            },
          ]
        }
        if (query.includes('information_schema.tables')) return [{ exists: false }]
        if (query.includes('information_schema.columns')) {
          const table = params[1]
          if (table !== 'crm_leads') return []
          return [
            'id', 'organization_id', 'whatsapp', 'email', 'name', 'company', 'notes', 'value', 'status',
            'follow_up_date', 'follow_up_note', 'campaign_source', 'utm_source', 'utm_medium', 'utm_campaign',
            'utm_content', 'utm_term', 'ai_agent', 'created_at', 'first_contact_at',
          ].map(column_name => ({ column_name }))
        }
        if (query.includes('from public.outreach_convos')) return []
        if (query.includes('from public.outreach_msgs')) return []
        if (query.includes('from "autonomia".crm_leads')) return CRM_LEADS_FIXTURE
        if (query.includes('from public.ctwa_referrals')) return []
        return []
      },
    },
  })

  const { syncAgentsAndCompanies } = await import('../src/lib/sync-agents')

  try {
    const report = await syncAgentsAndCompanies()

    await test('sync roda com sucesso e importa os 3 leads novos do CRM', () => {
      assert.equal(report.ok, true)
      assert.ok(report.leadsCreated >= 3, `esperava pelo menos 3 leads criados, veio ${report.leadsCreated}`)
    })

    const [leadWhatsapp] = await testDb
      .select()
      .from(schema.recoveryLeads)
      .where(eq(schema.recoveryLeads.phone, '11988887777'))

    const [leadEmail] = await testDb
      .select()
      .from(schema.recoveryLeads)
      .where(eq(schema.recoveryLeads.email, 'lead.so.email@exemplo.com'))

    const [leadCompleto] = await testDb
      .select()
      .from(schema.recoveryLeads)
      .where(eq(schema.recoveryLeads.phone, '11977776666'))

    await test('(a) lead com telefone e sem e-mail -> channel=whatsapp', () => {
      assert.ok(leadWhatsapp, 'lead com whatsapp deveria ter sido criado')
      assert.equal(leadWhatsapp.channel, 'whatsapp')
      assert.equal(leadWhatsapp.email, null)
    })

    await test('(b) lead com e-mail e sem telefone -> channel=email (bug corrigido, não mais hardcoded whatsapp)', () => {
      assert.ok(leadEmail, 'lead só de e-mail deveria ter sido criado')
      assert.equal(leadEmail.channel, 'email')
      assert.equal(leadEmail.phone, 'lead.so.email@exemplo.com', 'sem telefone, phone cai pro fallback email (mesmo comportamento de antes desta correção)')
    })

    await test('(c) lead com telefone E e-mail -> channel=whatsapp (cleanPhone é checado primeiro; comportamento já existente, não é bug novo)', () => {
      assert.ok(leadCompleto, 'lead completo deveria ter sido criado')
      assert.equal(leadCompleto.channel, 'whatsapp')
      assert.equal(leadCompleto.email, 'lead.completo@exemplo.com', 'e-mail continua sendo gravado mesmo com channel=whatsapp')
    })

    // ─── Confirma item 3 do briefing: o lead 'email' cai em Mineração > E-mail,
    // não em "E-mail" solto, porque trackingSource default é
    // 'mineracao_prospeccao' (bate em CATEGORY_RULES 'mineracao' primeiro) e,
    // dentro do universo mineracao, channel='email' bate na subcategoria email.
    await test('(confirmação item 3) lead email cai em mineracao_email no inbox-channel-filter, não em email solto', async () => {
      const { channelWhereCondition, classifyChannelInMemory, classifyMineracaoSubchannel } = await import(
        '../src/lib/inbox-channel-filter'
      )

      assert.equal(leadEmail!.trackingSource, 'mineracao_prospeccao')

      const classificacao = classifyChannelInMemory({
        channel: leadEmail!.channel,
        platform: leadEmail!.platform,
        trackingSource: leadEmail!.trackingSource,
        phone: leadEmail!.phone,
      })
      assert.equal(classificacao.isMineracao, true, 'nível principal deveria classificar como mineracao (trackingSource bate em %prospeccao%)')
      assert.equal(classificacao.isEmail, false, 'NÃO deveria cair em "email" solto no nível principal')

      const sub = classifyMineracaoSubchannel({
        channel: leadEmail!.channel,
        platform: leadEmail!.platform,
        trackingSource: leadEmail!.trackingSource,
        phone: leadEmail!.phone,
      })
      assert.equal(sub, 'email', 'dentro de mineracao, o canal real de contato deveria ser email')

      const cond = channelWhereCondition('mineracao_email')!
      const rows = await testDb
        .select({ id: schema.recoveryLeads.id })
        .from(schema.recoveryLeads)
        .where(cond)
      assert.ok(
        rows.some(r => r.id === leadEmail!.id),
        'o WHERE de mineracao_email deveria incluir o lead de e-mail recém-importado do CRM',
      )
    })
  } finally {
    await sql.end({ timeout: 2 })
    disposable.stop()
  }
}

main()
  .then(() => {
    console.log('\nOK: regressão do bug de channel hardcoded no sync do CRM (bloco 5) rodou contra Postgres descartável real.')
  })
  .catch(err => {
    console.error('Erro fatal no teste de sync-agents (CRM channel):', err)
    process.exitCode = 1
  })
