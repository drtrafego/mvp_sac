// Teste do fix de ordenação do Inbox por última mensagem
// (src/app/api/inbox/route.ts e src/app/(dashboard)/inbox/layout.tsx).
//
// BUG: a lista de conversas ordena por
//   COALESCE(lastActionAt, updatedAt, createdAt) DESC
// e COALESCE pega o PRIMEIRO valor não nulo. Uma vez que lastActionAt é
// gravado (mesmo que só na criação do lead, dias atrás), qualquer
// atualização posterior que só toque updatedAt fica IGNORADA pra sempre pela
// ordenação, mesmo que uma mensagem nova de verdade tenha chegado depois.
//
// FIX (opção A, escolhida no lugar de trocar a ordem do COALESCE): lastActionAt
// vira a fonte de verdade única, atualizada em TODO ponto que grava uma
// mensagem real (inbound ou outbound), não só na criação do lead. Cobre:
//   - src/app/api/webhooks/instagram/[slug]/route.ts e .../instagram/route.ts
//     (upsert do lead só tocava updatedAt)
//   - src/lib/sync-agents.ts, blocos 3 e 4 (só gravava lastActionAt ao criar
//     o lead, nunca de novo quando o lead já existia e chegavam mensagens novas)
//   - src/lib/ai-reply.ts (resposta da IA nunca tocava lastActionAt/updatedAt)
//   - src/app/api/inbox/[leadId]/route.ts (resposta manual do agente humano
//     só tocava updatedAt)
//   - src/lib/instagram-comment-processor.ts (DM de comentário só tocava
//     updatedAt pro lead já existente)
//
// Este teste sobe um Postgres DESCARTÁVEL de verdade via Docker (mesmo
// padrão de scripts/hermes-conversion-webhook.test.ts), aplica o schema real
// via `drizzle-kit push`, mocka só as peças de borda (assinatura da Meta,
// after() do Next, e o banco de Agentes IA usado pelo sync-agents) e chama o
// CÓDIGO REAL: o handler POST do webhook do Instagram e
// syncAgentsAndCompanies(). Depois roda a MESMA query de ordenação do Inbox
// (COALESCE(lastActionAt, updatedAt, createdAt) DESC) direto no Postgres
// descartável e confere que o lead que acabou de receber mensagem nova
// aparece no topo.
//
// Cenário provado, pros dois caminhos pedidos na tarefa:
//   (1) Instagram: lead criado há 5 dias (lastActionAt antigo) recebe uma
//       DM nova hoje -> lastActionAt atualiza -> lead sobe pro topo.
//   (2) sync-agents (lead já existente): lead criado há 5 dias recebe uma
//       mensagem nova hoje via conversas do agente IA -> lastActionAt
//       atualiza -> lead sobe pro topo. Confere também que NÃO cria um lead
//       duplicado (reaproveita o existente).
//
// Uso: npx tsx --experimental-test-module-mocks --test scripts/inbox-last-message-order.test.ts

process.env.META_APP_SECRET = 'test-secret-instagram-webhook'

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, desc, sql } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'
import { NextRequest as RealNextRequest, NextResponse as RealNextResponse } from 'next/server'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'inbox_last_message_order_test'

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
  spawnSync('docker', ['rm', '-f', '-v', CONTAINER_NAME], { stdio: 'ignore' })
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
      spawnSync('docker', ['rm', '-f', '-v', CONTAINER_NAME], { stdio: 'ignore' })
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

async function main() {
  if (!dockerAvailable()) {
    console.error('Docker não disponível: este teste precisa de um Postgres descartável real.')
    process.exitCode = 1
    return
  }

  const disposable = await startDisposablePostgres()
  applyRealSchema(disposable.url)

  const pgClient = postgres(disposable.url)
  const testDb = drizzle(pgClient, { schema })

  // Mesma query de ordenação do Inbox (src/app/api/inbox/route.ts e
  // src/app/(dashboard)/inbox/layout.tsx), rodada direto contra o Postgres
  // descartável: prova o efeito real do fix na ordenação, não só que os
  // campos foram gravados.
  async function topLeadId(companyId: number): Promise<number | undefined> {
    const rows = await testDb
      .select({ id: schema.recoveryLeads.id })
      .from(schema.recoveryLeads)
      .where(eq(schema.recoveryLeads.companyId, companyId))
      .orderBy(desc(sql`COALESCE(${schema.recoveryLeads.lastActionAt}, ${schema.recoveryLeads.updatedAt}, ${schema.recoveryLeads.createdAt})`))
      .limit(1)
    return rows[0]?.id
  }

  // ─── Mocks (precisam ser registrados ANTES do primeiro import dinâmico das rotas) ─
  let capturedAfterPromise: Promise<unknown> | undefined

  mock.module('@/lib/db', { namedExports: { db: testDb } })

  // A validação de assinatura x-hub-signature-256 da Meta não é o que este
  // teste prova (isso já é coberto em outro lugar); aqui ela é bypassada pra
  // focar na ordenação. O secret ainda precisa existir (META_APP_SECRET
  // acima) pra rota não recusar a requisição com 503 antes de chegar na
  // verificação.
  mock.module('@/lib/meta-signature', {
    namedExports: { verifyMetaSignature: () => true },
  })

  mock.module('next/server', {
    namedExports: {
      NextRequest: RealNextRequest,
      NextResponse: RealNextResponse,
      after: (fn: () => unknown) => {
        capturedAfterPromise = Promise.resolve().then(fn)
      },
    },
  })

  const { POST: instagramSlugPost } = await import('../src/app/api/webhooks/instagram/[slug]/route')

  try {
    // ════════════════════════════════════════════════════════════════════
    // Cenário 1: Instagram — DM nova pra lead com lastActionAt antigo
    // ════════════════════════════════════════════════════════════════════
    await test('Instagram: DM nova sobe o lead pro topo do Inbox mesmo com lastActionAt gravado há dias', async () => {
      const [company] = await testDb
        .insert(schema.companies)
        .values({ name: 'IG Order Teste', slug: 'ig-order-teste' })
        .returning()

      const senderId = '778899001122'
      const igPhone = `ig_${senderId}`
      const cincoDiasAtras = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
      const umaHoraAtras = new Date(Date.now() - 60 * 60 * 1000)

      // Lead "antigo": lastActionAt gravado há 5 dias (na criação) e NUNCA
      // mais atualizado até hoje — exatamente o cenário do bug relatado.
      // botPaused=true pra não disparar generateAndSendAiReply() de verdade
      // (fora do escopo deste teste, e sem mock da ponte de IA).
      const [leadAntigo] = await testDb
        .insert(schema.recoveryLeads)
        .values({
          companyId: company.id,
          platform: 'instagram',
          channel: 'instagram',
          eventType: 'instagram_direct',
          phone: igPhone,
          name: 'Cliente Antigo IG',
          status: 'in_conversation',
          trackingSource: 'instagram_direct',
          botPaused: true,
          createdAt: cincoDiasAtras,
          updatedAt: cincoDiasAtras,
          lastActionAt: cincoDiasAtras,
        })
        .returning()

      // Lead de controle: atividade mais recente que o lead antigo, mas
      // mais antiga que a mensagem nova que está prestes a chegar. Prova a
      // ORDEM, não só o valor gravado.
      const [leadControle] = await testDb
        .insert(schema.recoveryLeads)
        .values({
          companyId: company.id,
          platform: 'sac',
          channel: 'whatsapp',
          eventType: 'atendimento',
          phone: '5511900001234',
          name: 'Cliente Controle',
          status: 'in_conversation',
          trackingSource: 'whatsapp_direto',
          createdAt: umaHoraAtras,
          updatedAt: umaHoraAtras,
          lastActionAt: umaHoraAtras,
        })
        .returning()

      // Antes da mensagem nova: o controle (1h atrás) já vence o antigo (5 dias atrás).
      assert.equal(
        await topLeadId(company.id),
        leadControle.id,
        'antes da DM nova, o lead de controle (mais recente) deveria estar no topo'
      )

      const body = {
        object: 'instagram',
        entry: [
          {
            id: 'page-ig-order-teste',
            messaging: [
              {
                sender: { id: senderId },
                message: { mid: 'mid-dm-nova-1', text: 'oi, voltei' },
              },
            ],
          },
        ],
      }

      const req = new RealNextRequest('https://sac.example.com/api/webhooks/instagram/ig-order-teste', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=fake-bypassed' },
        body: JSON.stringify(body),
      })

      const antesDoEnvio = Date.now()
      const res = await instagramSlugPost(req, { params: Promise.resolve({ slug: 'ig-order-teste' }) })
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.deepEqual(json, { success: true })

      await capturedAfterPromise // se algo tivesse rodado no after(), deixa terminar

      const [leadDepois] = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.id, leadAntigo.id))
      assert.ok(leadDepois, 'lead antigo deveria continuar existindo (upsert, não duplicado)')
      assert.ok(
        leadDepois.lastActionAt && leadDepois.lastActionAt.getTime() >= antesDoEnvio - 1000,
        `lastActionAt deveria ter sido atualizado pra agora, veio ${leadDepois.lastActionAt?.toISOString()}`
      )
      assert.ok(
        leadDepois.updatedAt && leadDepois.updatedAt.getTime() >= antesDoEnvio - 1000,
        'updatedAt também deveria ter sido atualizado'
      )

      const mensagens = await testDb
        .select()
        .from(schema.whatsappMessages)
        .where(eq(schema.whatsappMessages.leadId, leadAntigo.id))
      assert.equal(mensagens.length, 1, 'deveria ter gravado a DM nova como mensagem inbound')
      assert.equal(mensagens[0].content, 'oi, voltei')
      assert.equal(mensagens[0].direction, 'inbound')

      // Depois da mensagem nova: o lead antigo (agora com lastActionAt de
      // agora) precisa vencer o controle. Isto é o que estava quebrado antes
      // do fix: lastActionAt já gravado há 5 dias fazia o COALESCE ignorar
      // pra sempre a atividade nova.
      assert.equal(
        await topLeadId(company.id),
        leadAntigo.id,
        'depois da DM nova, o lead antigo deveria ter subido pro topo do Inbox'
      )
    })

    // ════════════════════════════════════════════════════════════════════
    // Cenário 2: sync-agents — mensagem nova pra lead JÁ EXISTENTE
    // ════════════════════════════════════════════════════════════════════
    await test('sync-agents: mensagem nova pra lead existente sobe ele pro topo do Inbox (sem duplicar o lead)', async () => {
      // Empresa com o slug que syncAgentsAndCompanies() usa por padrão pra
      // "AutonomIA" (ver defaultCompanies em src/lib/sync-agents.ts):
      // pré-criada aqui pra garantir que é a MESMA linha usada pelo sync,
      // então dá pra afirmar sobre o id dela com segurança.
      const [company] = await testDb
        .insert(schema.companies)
        .values({ name: 'AutonomIA', slug: 'autonomia' })
        .returning()

      const telefone = '5511977776666'
      const cincoDiasAtras = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
      const umaHoraAtras = new Date(Date.now() - 60 * 60 * 1000)
      const agora = new Date()

      const [leadExistente] = await testDb
        .insert(schema.recoveryLeads)
        .values({
          companyId: company.id,
          phone: telefone,
          name: 'Atendimento Cliente Antigo',
          platform: 'sac',
          channel: 'whatsapp',
          eventType: 'atendimento_ia',
          status: 'in_conversation',
          trackingSource: 'agente_ia',
          createdAt: cincoDiasAtras,
          updatedAt: cincoDiasAtras,
          lastActionAt: cincoDiasAtras,
        })
        .returning()

      const [leadControle] = await testDb
        .insert(schema.recoveryLeads)
        .values({
          companyId: company.id,
          phone: '5511900009999',
          name: 'Cliente Controle 2',
          platform: 'sac',
          channel: 'whatsapp',
          eventType: 'atendimento',
          status: 'in_conversation',
          trackingSource: 'whatsapp_direto',
          createdAt: umaHoraAtras,
          updatedAt: umaHoraAtras,
          lastActionAt: umaHoraAtras,
        })
        .returning()

      assert.equal(
        await topLeadId(company.id),
        leadControle.id,
        'antes do sync, o lead de controle (mais recente) deveria estar no topo'
      )

      const sessionId = 'sess-existing-lead-1'
      const schemaName = 'agent_autonomia_teste'

      // Router simples por substring da query: cobre só os SELECTs que este
      // cenário precisa, o resto (outreach, CRM, ctwa) responde vazio pra
      // não acionar os blocos 4/5/6 do sync.
      async function queryAgentsDbMock(query: string): Promise<unknown[] | null> {
        if (query.includes('from public.agents')) {
          return [
            {
              id: 'agent-1',
              organization_id: 'org-1',
              org_slug: 'autonomia-teste',
              org_name: 'AutonomIA Teste',
              slug: 'autonomia-teste',
              schema_name: schemaName,
              name: 'AutonomIA Teste',
            },
          ]
        }
        if (query.includes('.conversations')) {
          return [
            {
              session_id: sessionId,
              chat_id: telefone,
              channel: 'whatsapp',
              title: 'Atendimento Cliente Antigo',
              started_at: cincoDiasAtras.toISOString(),
              ended_at: agora.toISOString(),
              message_count: 1,
            },
          ]
        }
        if (query.includes('.messages')) {
          return [
            {
              id: 'msg-nova-1',
              session_id: sessionId,
              role: 'user',
              content: 'mensagem nova via sync-agents',
              ts: agora.toISOString(),
              platform_message_id: null,
            },
          ]
        }
        if (query.includes('information_schema.columns')) return []
        if (query.includes('from public.outreach_convos')) return []
        if (query.includes('from public.leads')) return []
        if (query.includes('from public.ctwa_referrals')) return []
        return []
      }

      mock.module('@/lib/db/agents-db', {
        namedExports: {
          queryAgentsDb: queryAgentsDbMock,
          getAgentsDbUrl: async () => 'postgres://fake-agents-db-so-pro-mock-nao-usar-de-verdade',
        },
      })

      const { syncAgentsAndCompanies } = await import('../src/lib/sync-agents')

      const antesDoSync = Date.now()
      const report = await syncAgentsAndCompanies()
      assert.equal(report.ok, true, `sync deveria ter rodado com ok=true: ${report.message}`)

      const leadsComEsseTelefone = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.phone, telefone))
      assert.equal(leadsComEsseTelefone.length, 1, 'não deveria ter duplicado o lead existente')
      assert.equal(leadsComEsseTelefone[0].id, leadExistente.id)

      const leadDepois = leadsComEsseTelefone[0]
      assert.ok(
        leadDepois.lastActionAt && leadDepois.lastActionAt.getTime() >= antesDoSync - 60_000,
        `lastActionAt deveria ter sido atualizado pra hoje, veio ${leadDepois.lastActionAt?.toISOString()}`
      )

      const mensagens = await testDb
        .select()
        .from(schema.whatsappMessages)
        .where(eq(schema.whatsappMessages.leadId, leadExistente.id))
      assert.equal(mensagens.length, 1, 'deveria ter importado a mensagem nova pro lead já existente')
      assert.equal(mensagens[0].content, 'mensagem nova via sync-agents')

      assert.equal(
        await topLeadId(company.id),
        leadExistente.id,
        'depois do sync, o lead existente (com mensagem nova) deveria ter subido pro topo do Inbox'
      )
    })
  } finally {
    await pgClient.end({ timeout: 2 })
    disposable.stop()
  }
}

main().catch(err => {
  console.error('Erro fatal no teste de ordenação do Inbox:', err)
  process.exitCode = 1
})
