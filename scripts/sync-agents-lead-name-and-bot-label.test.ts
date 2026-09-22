// Teste de regressão dos bugs "nome do lead vem do assunto da conversa" e
// "Bot IA genérico em vez do nome real do agente" em src/lib/sync-agents.ts.
//
// BUG 1 (bloco 3, sync de conversas de agente IA): name: cv.title gravava o
// assunto/resumo da conversa (ex.: "Custo da eletrocauterização"), nunca o
// nome real da pessoa, e nunca atualizava depois da criação. Fix: prioridade
// agendamentos.nome > crm_leads.name válido (descarta placeholder "Lead N")
// > conversations.title > "Atendimento XXXX", recalculada a cada sync e só
// promovida (nunca rebaixada) num lead já existente. Ver resolveLeadName /
// inferStoredLeadNameSource / shouldUpdateLeadName em src/lib/sync-agents.ts.
//
// BUG 2 (bloco 2): agent.name (ex.: "Clara" pro Dr. Lucas) era lido só pra
// resolver companySlug e descartado. Fix: persiste em companies.agentDisplayName.
//
// Casos cobertos (os 4 exatos da investigação, um por telefone):
//   1. Gabriel Carvalho: só crm_leads tem nome bom -> usa o do CRM.
//   2. Andre Rabelo: idem, só crm_leads.
//   3. "Lead 7979": crm_leads.name bate no placeholder "Lead N" (descartado),
//      sem agendamento -> cai no título da conversa (comportamento atual
//      preservado quando não há fonte melhor).
//   4. Cleide Santos / "Resposta De Cleide": crm_leads tem nome ruim, mas
//      agendamentos tem o nome real dito na hora de marcar -> agendamentos
//      vence (prioridade maior), mesmo sendo o de MENOR cobertura.
//
// Mais dois testes de proteção:
//   5. Lead já com nome de verdade salvo (fora de agendamentos/crm_leads)
//      NUNCA é rebaixado por um título chegando na sync seguinte.
//   6. Lead criado só com título é PROMOVIDO pro nome de agendamentos que
//      aparece numa sync posterior (a pessoa marcou consulta depois).
//
// E a tolerância multi-empresa: agente sem agendamentos/crm_leads no schema
// (Gramado, AutonomIA) não pode quebrar o sync nem qualquer lead de outra
// empresa.
//
// Uso: npx tsx --experimental-test-module-mocks --test scripts/sync-agents-lead-name-and-bot-label.test.ts

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'sync_agents_lead_name_test'

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

// ─── Fixtures do "Agents DB" (public.agents + schema "drlucas") ───────────
const AGENTS_FIXTURE = [
  {
    id: 'agent-drlucas',
    organization_id: 'org-drlucas',
    org_slug: 'drlucas',
    org_name: 'Dr. Lucas',
    slug: 'drlucas',
    schema_name: 'drlucas',
    name: 'Clara', // BUG 2: nome de persona do bot, hoje descartado
  },
  {
    id: 'agent-gramado',
    organization_id: 'org-gramado',
    org_slug: 'gramado-plaza',
    org_name: 'Gramado Plaza',
    slug: 'gramado-plaza',
    schema_name: 'gramado_plaza', // sem agendamentos/crm_leads: tolerância multi-empresa
    name: 'Gramado Bot',
  },
]

// 4 conversas, uma por telefone/caso da investigação, todas no schema "drlucas"
const CONV_GABRIEL = { session_id: 's-gabriel', chat_id: '5511900000001', channel: 'whatsapp', title: 'Dúvida sobre valor de consulta', started_at: '2026-09-20T10:00:00Z', ended_at: '2026-09-20T10:05:00Z', message_count: 2 }
const CONV_ANDRE = { session_id: 's-andre', chat_id: '5511900000002', channel: 'whatsapp', title: 'Agendar retorno', started_at: '2026-09-20T11:00:00Z', ended_at: '2026-09-20T11:05:00Z', message_count: 2 }
const CONV_LEAD7979 = { session_id: 's-7979', chat_id: '5511900000003', channel: 'whatsapp', title: 'Horário de atendimento', started_at: '2026-09-20T12:00:00Z', ended_at: '2026-09-20T12:05:00Z', message_count: 2 }
const CONV_CLEIDE = { session_id: 's-cleide', chat_id: '5511900000004', channel: 'whatsapp', title: 'Custo da eletrocauterização', started_at: '2026-09-20T13:00:00Z', ended_at: '2026-09-20T13:05:00Z', message_count: 2 }
const CONV_GRAMADO = { session_id: 's-gramado-1', chat_id: '5511900000099', channel: 'whatsapp', title: 'Reserva mesa 4 pessoas', started_at: '2026-09-20T14:00:00Z', ended_at: '2026-09-20T14:05:00Z', message_count: 2 }

const MSGS_FIXTURE = [
  { id: 1, session_id: 's-gabriel', role: 'user', content: 'Oi', ts: '2026-09-20T10:00:00Z' },
  { id: 2, session_id: 's-andre', role: 'user', content: 'Oi', ts: '2026-09-20T11:00:00Z' },
  { id: 3, session_id: 's-7979', role: 'user', content: 'Oi', ts: '2026-09-20T12:00:00Z' },
  { id: 4, session_id: 's-cleide', role: 'user', content: 'Oi', ts: '2026-09-20T13:00:00Z' },
  { id: 5, session_id: 's-gramado-1', role: 'user', content: 'Oi', ts: '2026-09-20T14:00:00Z' },
]

// crm_leads.name: Gabriel e Andre com nome bom, "Lead 7979" placeholder
// (descartado pela regex), Cleide com nome RUIM (o crm captura errado).
const CRM_LEADS_FIXTURE = [
  { name: 'Gabriel Carvalho', phone: '5511900000001' },
  { name: 'Andre Rabelo', phone: '5511900000002' },
  { name: 'Lead 7979', phone: '5511900000003' },
  { name: 'Resposta De Cleide', phone: '5511900000004' },
]

// agendamentos.nome: só a Cleide tem (nome real dito na hora de marcar
// consulta), cobertura baixa de propósito (é o caso real da investigação).
const AGENDAMENTOS_FIXTURE = [
  { nome: 'Cleide Santos', telefone: null, telefone_norm: '5511900000004' },
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

  // Estado mutável simulando o Agents DB entre as duas rodadas de sync deste
  // teste. node:test só permite mock.module() UMA vez por specifier (uma 2ª
  // chamada lança ERR_INVALID_STATE), então em vez de remockar entre as
  // rodadas, o mock é registrado uma única vez e lê estes arrays/mapas
  // mutáveis, que os testes alteram por referência antes da 2ª chamada de
  // syncAgentsAndCompanies().
  const agendamentosAtivos = [...AGENDAMENTOS_FIXTURE]
  const convsDrLucasAtivas = [CONV_GABRIEL, CONV_ANDRE, CONV_LEAD7979, CONV_CLEIDE]
  const msgsAtivas = [...MSGS_FIXTURE]

  mock.module('@/lib/db', {
    namedExports: { db: testDb },
  })

  mock.module('@/lib/db/agents-db', {
    namedExports: {
      getAgentsDbUrl: async () => 'postgres://fake-agents-db-url/test',
      queryAgentsDb: async (query: string, params: unknown[] = []) => {
        if (query.includes('from public.agents')) return AGENTS_FIXTURE
        if (query.includes('information_schema.columns')) return []
        if (query.includes('information_schema.tables')) {
          const [tableSchema, tableName] = params as [string, string]
          const exists =
            tableSchema === 'drlucas' && (tableName === 'agendamentos' || tableName === 'crm_leads')
          return [{ exists }]
        }
        if (query.includes('from "drlucas".conversations')) {
          return convsDrLucasAtivas
        }
        if (query.includes('from "gramado_plaza".conversations')) {
          return [CONV_GRAMADO]
        }
        if (query.includes('from "drlucas".messages') || query.includes('from "gramado_plaza".messages')) {
          const sessionIds = params[0] as string[]
          return msgsAtivas.filter(m => sessionIds.includes(m.session_id))
        }
        if (query.includes('from "drlucas".agendamentos')) return agendamentosAtivos
        if (query.includes('from "drlucas".crm_leads')) return CRM_LEADS_FIXTURE
        // gramado_plaza não tem agendamentos/crm_leads: tableExists já
        // devolve false acima, então essas duas queries nem deveriam ser
        // chamadas pra esse schema; se forem, devolver vazio é seguro.
        if (query.includes('from "gramado_plaza".agendamentos') || query.includes('from "gramado_plaza".crm_leads')) return []
        if (query.includes('from public.outreach_convos')) return []
        if (query.includes('from public.outreach_msgs')) return []
        if (query.includes('from public.leads')) return []
        if (query.includes('from public.ctwa_referrals')) return []
        return []
      },
    },
  })

  const { syncAgentsAndCompanies, resolveLeadName, inferStoredLeadNameSource, shouldUpdateLeadName } = await import(
    '../src/lib/sync-agents'
  )

  try {
    // ─── Testes unitários dos resolvers puros (rápidos, sem I/O) ───────────
    await test('resolveLeadName: agendamento > crm > title > fallback', () => {
      assert.deepEqual(
        resolveLeadName({ agendamentoName: 'Cleide Santos', crmName: 'Resposta De Cleide', title: 'x', fallback: 'f' }),
        { name: 'Cleide Santos', source: 'agendamento' }
      )
      assert.deepEqual(
        resolveLeadName({ agendamentoName: null, crmName: 'Gabriel Carvalho', title: 'x', fallback: 'f' }),
        { name: 'Gabriel Carvalho', source: 'crm' }
      )
      assert.deepEqual(
        resolveLeadName({ agendamentoName: null, crmName: 'Lead 7979', title: 'Horário de atendimento', fallback: 'f' }),
        { name: 'Horário de atendimento', source: 'title' },
        'crm_leads.name que bate ^Lead \\d+$ é descartado como placeholder'
      )
      assert.deepEqual(
        resolveLeadName({ agendamentoName: null, crmName: null, title: null, fallback: 'Atendimento 0001' }),
        { name: 'Atendimento 0001', source: 'fallback' }
      )
    })

    await test('shouldUpdateLeadName: nunca rebaixa, promove quando fonte é igual ou melhor', () => {
      const nomeReal = { name: 'Cleide Santos', source: 'crm' as const }
      assert.equal(
        shouldUpdateLeadName(nomeReal, { name: 'Custo da eletrocauterização', source: 'title' }),
        false,
        'título não pode rebaixar um nome de verdade já salvo'
      )
      assert.equal(
        shouldUpdateLeadName(nomeReal, { name: 'Cleide Santos (Agenda)', source: 'agendamento' }),
        true,
        'agendamento (rank maior) sempre pode promover'
      )
      assert.equal(
        shouldUpdateLeadName({ name: 'Resposta De Cleide', source: 'crm' }, { name: 'Cleide Santos', source: 'crm' }),
        true,
        'mesma fonte, valor novo diferente: atualiza (freshest wins dentro do mesmo rank)'
      )
    })

    await test('inferStoredLeadNameSource: placeholder e fallback nunca viram "crm"', () => {
      assert.equal(inferStoredLeadNameSource('Atendimento 1234', null, 'Atendimento 1234'), 'fallback')
      assert.equal(inferStoredLeadNameSource('Lead 42', null, 'Atendimento 0042'), 'fallback')
      assert.equal(inferStoredLeadNameSource('Custo da eletrocauterização', 'Custo da eletrocauterização', 'Atendimento 0004'), 'title')
      assert.equal(inferStoredLeadNameSource('Cleide Santos', 'Custo da eletrocauterização', 'Atendimento 0004'), 'crm')
    })

    // ─── 1ª rodada de sync (drlucas sem agendamentos pra Lead 7979 ainda) ──
    const report1 = await syncAgentsAndCompanies()
    assert.equal(report1.ok, true, `sync deveria ter rodado ok: ${report1.message}`)

    const getLeadByPhone = async (phone: string) => {
      const [lead] = await testDb.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.phone, phone))
      return lead
    }

    const leadGabriel = await getLeadByPhone('5511900000001')
    const leadAndre = await getLeadByPhone('5511900000002')
    const lead7979 = await getLeadByPhone('5511900000003')
    const leadCleide = await getLeadByPhone('5511900000004')
    const leadGramado = await getLeadByPhone('5511900000099')

    await test('caso 1: Gabriel Carvalho vem do crm_leads (sem agendamento)', () => {
      assert.ok(leadGabriel, 'lead do Gabriel deveria existir')
      assert.equal(leadGabriel!.name, 'Gabriel Carvalho')
    })

    await test('caso 2: Andre Rabelo vem do crm_leads (sem agendamento)', () => {
      assert.ok(leadAndre, 'lead do Andre deveria existir')
      assert.equal(leadAndre!.name, 'Andre Rabelo')
    })

    await test('caso 3: "Lead 7979" no crm é placeholder descartado, cai no título da conversa', () => {
      assert.ok(lead7979, 'lead 7979 deveria existir')
      assert.equal(lead7979!.name, 'Horário de atendimento')
    })

    await test('caso 4: Cleide Santos (agendamentos) vence Resposta De Cleide (crm_leads)', () => {
      assert.ok(leadCleide, 'lead da Cleide deveria existir')
      assert.equal(leadCleide!.name, 'Cleide Santos')
    })

    await test('tolerância multi-empresa: Gramado (sem agendamentos/crm_leads) não quebra e usa título', () => {
      assert.ok(leadGramado, 'lead do Gramado deveria existir mesmo sem agendamentos/crm_leads')
      assert.equal(leadGramado!.name, 'Reserva mesa 4 pessoas')
    })

    await test('BUG 2: companies.agentDisplayName recebe o nome real do agente (Clara)', async () => {
      const [companyDrLucas] = await testDb.select().from(schema.companies).where(eq(schema.companies.slug, 'drlucas'))
      assert.ok(companyDrLucas, 'empresa drlucas deveria existir')
      assert.equal(companyDrLucas!.agentDisplayName, 'Clara')

      const [companyGramado] = await testDb.select().from(schema.companies).where(eq(schema.companies.slug, 'gramado-plaza'))
      assert.ok(companyGramado, 'empresa gramado-plaza deveria existir')
      assert.equal(companyGramado!.agentDisplayName, 'Gramado Bot')
    })

    // ─── Proteção: nome de verdade manual nunca é rebaixado por título ─────
    // Simula um lead que JÁ tem nome de verdade vindo de outra fonte
    // (ex.: bloco 5, CRM central), num telefone que só tem TÍTULO na
    // conversa do agente (sem crm_leads/agendamentos pra ele). O bloco 3
    // não pode rebaixar isso pro título.
    const NOVO_TELEFONE = '5511900000077'
    await testDb.insert(schema.recoveryLeads).values({
      companyId: leadCleide!.companyId,
      phone: NOVO_TELEFONE,
      name: 'Nome Já Correto Manual',
      platform: 'sac',
      channel: 'whatsapp',
      eventType: 'atendimento_ia',
      status: 'in_conversation',
    })

    const CONV_NOVO = { session_id: 's-novo', chat_id: NOVO_TELEFONE, channel: 'whatsapp', title: 'Assunto qualquer da conversa', started_at: '2026-09-21T09:00:00Z', ended_at: '2026-09-21T09:05:00Z', message_count: 1 }

    // Muta os arrays lidos pelo ÚNICO mock de queryAgentsDb (registrado uma
    // vez lá em cima) pra simular o estado do Agents DB na 2ª rodada: liga
    // agendamentos.nome pro "Lead 7979" (promoção do caso 6) e inclui a
    // conversa nova (proteção do nome manual).
    agendamentosAtivos.push({ nome: 'Fulano Sete Nove', telefone: null, telefone_norm: '5511900000003' })
    convsDrLucasAtivas.push(CONV_NOVO)
    msgsAtivas.push({ id: 6, session_id: 's-novo', role: 'user', content: 'Oi', ts: '2026-09-21T09:00:00Z' })

    const report2 = await syncAgentsAndCompanies()
    assert.equal(report2.ok, true, `2ª sync deveria ter rodado ok: ${report2.message}`)

    const leadNovo = await getLeadByPhone(NOVO_TELEFONE)
    await test('proteção: nome de verdade manual não é rebaixado pelo título da conversa', () => {
      assert.ok(leadNovo, 'lead do telefone novo deveria existir')
      assert.equal(leadNovo!.name, 'Nome Já Correto Manual')
    })

    const lead7979Depois = await getLeadByPhone('5511900000003')
    await test('caso 6: lead criado só com título é promovido pro nome real quando agendamentos aparece depois', () => {
      assert.ok(lead7979Depois, 'lead 7979 deveria existir')
      assert.equal(lead7979Depois!.name, 'Fulano Sete Nove')
    })

    const leadGabrielDepois = await getLeadByPhone('5511900000001')
    await test('idempotência: nome que já está correto não é reescrito à toa numa 2ª rodada', () => {
      assert.equal(leadGabrielDepois!.name, 'Gabriel Carvalho')
    })
  } finally {
    await sql.end({ timeout: 2 })
    disposable.stop()
  }
}

main()
  .then(() => {
    console.log('\nOK: regressão dos bugs "nome do lead" e "Bot IA genérico" rodou contra Postgres descartável real.')
  })
  .catch(err => {
    console.error('Erro fatal no teste de sync-agents (lead name / bot label):', err)
    process.exitCode = 1
  })
