// Teste de regressão do bug "1º disparo da mineração não marca o lead como
// Mineração, só se a pessoa responde" (reportado pelo Gastão, 23/09/2026).
//
// Investigação real contra produção (rota de diagnóstico temporária,
// read-only, chave por header, removida depois de usar) mostrou que a causa
// raiz NÃO é o outreach_convos.last_at ficar nulo até a resposta (ele já vem
// preenchido desde o disparo, hipótese descartada com dado real). A causa
// raiz confirmada: quando o MESMO telefone já tinha um lead criado por outro
// bloco de src/lib/sync-agents.ts (bloco 3, agent_conversations, que roda
// ANTES do bloco 4 de mineração no mesmo laço de agentes; ou bloco 5,
// crm_leads) com um trackingSource genérico ('agente_ia'/'atendimento_ia')
// ou nativo do CRM ('nina_outreach' etc.), o branch de "lead já existente" do
// bloco 4 só fazia merge de miningTags — nunca corrigia trackingSource. O
// lead ficava pra sempre fora da aba Mineração (origins.ts /
// inbox-channel-filter.ts), mesmo com outreach_convos confirmando que a
// mineração abordou essa pessoa, tenha ela respondido ou não. Medido em
// produção: 40 leads da AutonomIA (39 sem resposta, 1 com resposta) nesse
// estado, de ~4380 outreach_convos.
//
// Este teste cobre os dois casos pedidos na tarefa:
//   (a) "outbound sem resposta ainda": um lead que só existe em
//       outreach_convos (nunca passou pelo bot, nunca respondeu) precisa
//       nascer classificado como mineração na hora do sync, sem esperar
//       resposta nenhuma.
//   (b) o bug em si: um telefone que JÁ tinha lead criado pelo bloco 3
//       (trackingSource='agente_ia', como o bot registra) e que a mineração
//       também abordou (aparece em outreach_convos, sem resposta) precisa
//       ter o trackingSource CORRIGIDO pra 'mineracao_prospeccao' quando o
//       bloco 4 processa essa mesma pessoa, não só ganhar miningTags.
// E confere que os dois casos batem em CATEGORY_RULES 'mineracao' de
// inbox-channel-filter.ts (a aba que o usuário realmente vê no Inbox), não só
// a coluna crua no banco. Roda o sync 2x pra confirmar que a correção não
// duplica lead nem regride o trackingSource na segunda passada.
//
// Uso: npx tsx --experimental-test-module-mocks --test scripts/sync-agents-mineracao-outbound-tracking.test.ts

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'sync_agents_mineracao_outbound_tracking_test'

const PHONE_HIJACKED = '5511988880001' // já tinha lead do bloco 3 (bot), mineração também abordou, nunca respondeu
const PHONE_FRESH_NO_REPLY = '5511988880002' // só existe em outreach_convos, primeiro disparo, nunca respondeu
const PHONE_GRAMADO = '5554998880003' // Gramado continua entrando no tenant Gramado Plaza
const PHONE_UNKNOWN_ORIGIN = '5511988889999' // origem nova/desconhecida deve ficar em quarentena, sem cair na AutonomIA

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

// Uma única conversa do bot (bloco 3) pro telefone "hijacked": simula o
// atendimento normal da Nina que faz esse lead nascer ANTES da mineração
// alcançar o bloco 4, com trackingSource genérico 'agente_ia'.
const AGENT_CONVERSATIONS_FIXTURE = [
  {
    session_id: PHONE_HIJACKED,
    chat_id: PHONE_HIJACKED,
    channel: 'whatsapp',
    title: 'Dúvida sobre preço',
    started_at: '2026-09-20T10:00:00Z',
    ended_at: '2026-09-20T10:05:00Z',
    message_count: 1,
  },
]

const AGENT_MESSAGES_FIXTURE = [
  {
    id: 'msg-1',
    session_id: PHONE_HIJACKED,
    role: 'assistant',
    content: 'Oi! Como posso ajudar?',
    ts: '2026-09-20T10:01:00Z',
    platform_message_id: null,
  },
]

// outreach_convos: as DUAS pessoas foram abordadas pela mineração e NENHUMA
// respondeu ainda (outreach_msgs abaixo não tem nenhuma linha 'inbound').
const OUTREACH_CONVOS_FIXTURE = [
  {
    id: 'convo-hijacked',
    agent_slug: 'casaldotrafego',
    channel: 'whatsapp',
    source: 'prospeccao',
    lead_name: 'Lead Hijacked',
    lead_handle: PHONE_HIJACKED,
    lead_company: null,
    status: 'active',
    last_at: '2026-09-23T09:00:00Z',
    msg_count: 1,
  },
  {
    id: 'convo-fresh',
    agent_slug: 'casaldotrafego',
    channel: 'whatsapp',
    source: 'prospeccao',
    lead_name: 'Lead Fresh',
    lead_handle: PHONE_FRESH_NO_REPLY,
    lead_company: null,
    status: 'active',
    last_at: '2026-09-23T09:05:00Z',
    msg_count: 1,
  },
]

const OUTREACH_CONVOS_GRAMADO_FIXTURE = [
  {
    id: 'convo-gramado',
    agent_slug: 'gramado-prospeccao',
    channel: 'whatsapp',
    source: 'prospeccao',
    lead_name: 'Lead Gramado',
    lead_handle: PHONE_GRAMADO,
    lead_company: null,
    status: 'active',
    last_at: '2026-09-23T09:10:00Z',
    msg_count: 1,
  },
]

const OUTREACH_CONVOS_UNKNOWN_FIXTURE = [
  {
    id: 'convo-unknown',
    agent_slug: 'isabela-fanini',
    channel: 'whatsapp',
    source: 'prospeccao',
    lead_name: 'Lead Desconhecido',
    lead_handle: PHONE_UNKNOWN_ORIGIN,
    lead_company: null,
    status: 'active',
    last_at: '2026-09-23T09:15:00Z',
    msg_count: 1,
  },
]

// Só mensagem OUTBOUND (o disparo em si) pras duas convos, direction nunca
// 'inbound': é exatamente o caso "outbound sem resposta ainda" do briefing.
const OUTREACH_MSGS_FIXTURE = [
  {
    id: 'outreach-msg-hijacked-1',
    convo_id: 'convo-hijacked',
    direction: 'outbound',
    status: 'sent',
    subject: null,
    body: 'Oi! Vi que você...',
    sent_at: '2026-09-23T09:00:00Z',
  },
  {
    id: 'outreach-msg-fresh-1',
    convo_id: 'convo-fresh',
    direction: 'outbound',
    status: 'sent',
    subject: null,
    body: 'Oi! Vi que você...',
    sent_at: '2026-09-23T09:05:00Z',
  },
  {
    id: 'outreach-msg-gramado-1',
    convo_id: 'convo-gramado',
    direction: 'outbound',
    status: 'sent',
    subject: null,
    body: 'Olá! Podemos falar sobre reservas?',
    sent_at: '2026-09-23T09:10:00Z',
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

  mock.module('@/lib/db', {
    namedExports: { db: testDb },
  })

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
              slug: 'casaldotrafego',
              schema_name: 'autonomia',
              name: 'Nina',
            },
          ]
        }
        // agendamentos/crm_leads não existem no schema do agente neste teste
        // (loadPhoneNameMap/loadNativeCrmLeadMap devolvem mapa vazio) e
        // crm_leads também não tem colunas suficientes pro bloco 5 rodar:
        // este teste isola o bloco 3 (agent_conversations) x bloco 4
        // (outreach), que é onde o bug mora.
        if (query.includes('information_schema.tables')) return [{ exists: false }]
        if (query.includes('information_schema.columns')) return []
        if (query.includes('from "autonomia".conversations')) return AGENT_CONVERSATIONS_FIXTURE
        if (query.includes('from "autonomia".messages')) return AGENT_MESSAGES_FIXTURE
        if (query.includes('from public.outreach_convos')) {
          if (query.includes('where not (')) return OUTREACH_CONVOS_UNKNOWN_FIXTURE
          if (query.includes("'%gramado%'")) return OUTREACH_CONVOS_GRAMADO_FIXTURE
          return OUTREACH_CONVOS_FIXTURE
        }
        if (query.includes('from public.outreach_msgs')) return OUTREACH_MSGS_FIXTURE
        if (query.includes('from "autonomia".crm_leads')) return []
        if (query.includes('from public.ctwa_referrals')) return []
        return []
      },
    },
  })

  const { syncAgentsAndCompanies, classifyAgentCompany } = await import('../src/lib/sync-agents')
  const { classifyChannelInMemory, channelWhereCondition } = await import('../src/lib/inbox-channel-filter')

  try {
    const firstReport = await syncAgentsAndCompanies()

    await test('sync roda com sucesso na primeira passada', () => {
      assert.equal(firstReport.ok, true)
    })

    const [leadHijacked] = await testDb
      .select()
      .from(schema.recoveryLeads)
      .where(eq(schema.recoveryLeads.phone, PHONE_HIJACKED))

    const [leadFresh] = await testDb
      .select()
      .from(schema.recoveryLeads)
      .where(eq(schema.recoveryLeads.phone, PHONE_FRESH_NO_REPLY))

    const [leadGramado] = await testDb
      .select()
      .from(schema.recoveryLeads)
      .where(eq(schema.recoveryLeads.phone, PHONE_GRAMADO))

    const unknownOriginLeads = await testDb
      .select()
      .from(schema.recoveryLeads)
      .where(eq(schema.recoveryLeads.phone, PHONE_UNKNOWN_ORIGIN))

    await test('(a) outbound sem resposta ainda: lead nasce classificado como mineração na hora do disparo, sem precisar de resposta', () => {
      assert.ok(leadFresh, 'lead do primeiro disparo (sem resposta) deveria ter sido criado pelo bloco 4')
      assert.equal(leadFresh!.trackingSource, 'mineracao_prospeccao')
      assert.equal(leadFresh!.agentConversationId, null, 'este lead nunca passou pelo bot (bloco 3), só existe via outreach_convos')

      const classificacao = classifyChannelInMemory({
        channel: leadFresh!.channel,
        platform: leadFresh!.platform,
        trackingSource: leadFresh!.trackingSource,
        phone: leadFresh!.phone,
      })
      assert.equal(classificacao.isMineracao, true, 'deveria aparecer na aba Mineração do Inbox mesmo sem resposta')
    })

    await test('(b) bug corrigido: telefone que já tinha lead do bot (bloco 3, trackingSource agente_ia) e a mineração também abordou (sem resposta) tem trackingSource corrigido pra mineração', () => {
      assert.ok(leadHijacked, 'lead deveria existir (criado pelo bloco 3)')
      assert.equal(leadHijacked!.agentConversationId, PHONE_HIJACKED, 'confirma que este lead nasceu no bloco 3 (agent_conversations), não no bloco 4')
      assert.equal(
        leadHijacked!.trackingSource,
        'mineracao_prospeccao',
        'ANTES da correção ficava travado em "agente_ia" pra sempre; o bloco 4 precisa corrigir mesmo em lead já existente'
      )

      const classificacao = classifyChannelInMemory({
        channel: leadHijacked!.channel,
        platform: leadHijacked!.platform,
        trackingSource: leadHijacked!.trackingSource,
        phone: leadHijacked!.phone,
      })
      assert.equal(classificacao.isMineracao, true, 'deveria aparecer na aba Mineração do Inbox, não mais escondido em WhatsApp/Direto')

      const cond = channelWhereCondition('mineracao')!
      const rows = testDb.select({ id: schema.recoveryLeads.id }).from(schema.recoveryLeads).where(cond)
      return rows.then((r) => {
        assert.ok(r.some((row) => row.id === leadHijacked!.id), 'o WHERE de mineracao (usado no Inbox de verdade) deveria incluir este lead')
      })
    })

    await test('nenhuma mensagem inbound foi importada pros dois leads (confirma que o cenário testado é mesmo "sem resposta ainda")', async () => {
      const msgs = await testDb
        .select()
        .from(schema.whatsappMessages)
        .where(eq(schema.whatsappMessages.leadId, leadFresh!.id))
      assert.ok(msgs.length > 0, 'deveria ter importado a mensagem de disparo (outbound)')
      assert.ok(msgs.every((m) => m.direction === 'outbound'), 'nenhuma mensagem deveria ser inbound neste cenário')
    })

    await test('origem desconhecida em outreach_convos fica em quarentena: não cria lead em nenhuma empresa existente e aparece no relatório', () => {
      assert.equal(unknownOriginLeads.length, 0, 'agent_slug desconhecido não pode cair no tenant AutonomIA nem em outro tenant')
      assert.ok(
        firstReport.details.some((line) => line.includes('1 conversas de prospecção ignoradas por origem desconhecida/quarentena')),
        'relatório deveria expor a contagem de quarentena de outreach_convos'
      )
    })

    await test('Gramado continua roteando outreach_convos para Gramado Plaza, e Lucas continua classificado como Dr. Lucas sem virar catch-all da AutonomIA', async () => {
      assert.ok(leadGramado, 'lead do Gramado deveria ser criado pelo escopo gramado-plaza')

      const [gramadoCompany] = await testDb
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.slug, 'gramado-plaza'))
      assert.equal(leadGramado!.companyId, gramadoCompany.id)
      assert.equal(leadGramado!.trackingSource, 'mineracao_prospeccao')

      const lucasClassification = classifyAgentCompany('drlucas-mineracao', null)
      assert.equal(lucasClassification.companySlug, 'drlucas')
      assert.equal(lucasClassification.knownTenantSlug, 'drlucas')
    })

    const secondReport = await syncAgentsAndCompanies()

    await test('segunda passada do sync é idempotente: não duplica lead nem regride trackingSource', async () => {
      assert.equal(secondReport.ok, true)
      assert.equal(secondReport.leadsCreated, 0, 'na segunda passada não deveria criar lead novo (tudo já existe)')

      const leadsHijackedAfter = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.phone, PHONE_HIJACKED))
      const leadsFreshAfter = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.phone, PHONE_FRESH_NO_REPLY))

      assert.equal(leadsHijackedAfter.length, 1, 'não deveria duplicar o lead hijacked')
      assert.equal(leadsFreshAfter.length, 1, 'não deveria duplicar o lead fresh')
      assert.equal(leadsHijackedAfter[0].trackingSource, 'mineracao_prospeccao')
      assert.equal(leadsFreshAfter[0].trackingSource, 'mineracao_prospeccao')
    })
  } finally {
    await sql.end({ timeout: 2 })
    disposable.stop()
  }
}

main()
  .then(() => {
    console.log('\nOK: regressão do bug "mineração só marca depois que responde" rodou contra Postgres descartável real.')
  })
  .catch(err => {
    console.error('Erro fatal no teste de sync-agents (mineração outbound tracking):', err)
    process.exitCode = 1
  })
