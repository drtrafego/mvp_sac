// Teste do webhook novo POST /api/webhooks/hermes/[slug]/conversion
// (src/app/api/webhooks/hermes/[slug]/conversion/route.ts).
//
// Sobe um Postgres DESCARTÁVEL de verdade via Docker (mesmo padrão de
// scripts/inbox-channel-filter.reconcile.test.ts), aplica o schema real do
// projeto nele via `drizzle-kit push`, e substitui só duas peças por mock
// (node:test mock.module, precisa da flag --experimental-test-module-mocks):
//   - '@/lib/db': o `db` vira uma instância real de drizzle-orm/postgres-js
//     apontando pro Postgres descartável (as queries do handler rodam de
//     verdade contra tabelas reais, não é um mock de JS).
//   - '@/lib/meta-conversions-api': sendConversionEvent vira um espião (não
//     precisa de token real do Meta, autorizado pela própria tarefa);
//     scheduleEventId continua sendo a função REAL.
//   - 'next/server': after() vira síncrono (chama o callback na hora e
//     guarda a Promise), porque a implementação real do Next só funciona
//     dentro do dispatch de requisição de verdade do framework (chamar o
//     handler exportado direto, fora do `next dev`/`next start`, faz o
//     after() real lançar "called outside a request scope"). NextRequest e
//     NextResponse continuam sendo as classes REAIS do Next.
//
// Casos cobertos (pedidos na tarefa):
//   (a) token errado -> 401, sem tocar no banco
//   (b) slug de empresa inexistente -> 404
//   (c) chamada válida -> 200 rápido, sendConversionEvent chamado com os
//       parâmetros certos (companyId, leadId, eventName, phone, value)
// Mais 2 casos de robustez que a própria rota implementa:
//   (d) phone ausente -> 400
//   (e) lead com o mesmo telefone já existe -> reaproveita o id, não duplica
//
// Regressão dos 4 fixes da rodada de correção do QA (22/09/2026):
//   (f) FIX 1 (CRÍTICO): 2 requisições concorrentes com o MESMO telefone
//       NOVO -> só 1 lead é criado (índice único parcial
//       recovery_leads_chat_company_phone_unique agora cobre platform=
//       'hermes' + INSERT...ON CONFLICT DO NOTHING no lugar do
//       SELECT-então-INSERT). Contra Postgres REAL, concorrência de verdade.
//   (g) FIX 2 (CRÍTICO): retry do bot pro MESMO evento SEM dataReserva/
//       horario (event_id cai no fallback não determinístico) -> só 1 linha
//       em meta_conversion_events e sendConversionEvent chamado só 1 vez,
//       não duas.
//   (h) FIX 4 (MÉDIO): phone tipo "N/A" (sem dígito suficiente) -> 400.
//
// Uso: npx tsx --experimental-test-module-mocks --test scripts/hermes-conversion-webhook.test.ts

process.env.SAC_WEBHOOK_SECRET = 'test-secret-hermes-webhook'

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'
import { scheduleEventId as realScheduleEventId } from '../src/lib/meta-conversions-api'
import { NextRequest as RealNextRequest, NextResponse as RealNextResponse } from 'next/server'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'hermes_conversion_webhook_test'
const TOKEN_CERTO = process.env.SAC_WEBHOOK_SECRET

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

type SendConversionCall = Parameters<typeof import('../src/lib/meta-conversions-api').sendConversionEvent>[0]

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

  // Empresa de teste, mesmo slug que o Gramado Plaza usará em produção
  // (documentado no comentário de contrato da rota) — usamos um slug próprio
  // de teste pra não colidir com nada real.
  const [company] = await testDb
    .insert(schema.companies)
    .values({ name: 'Gramado Plaza (teste)', slug: 'gramado-plaza-teste' })
    .returning()

  const [otherCompany] = await testDb
    .insert(schema.companies)
    .values({ name: 'Outra Empresa (teste)', slug: 'outra-empresa-teste' })
    .returning()
  void otherCompany

  // ─── Mocks (precisam ser registrados ANTES do primeiro import dinâmico da rota) ─
  const sendConversionCalls: SendConversionCall[] = []
  let capturedAfterPromise: Promise<unknown> | undefined

  mock.module('@/lib/db', {
    namedExports: { db: testDb },
  })

  mock.module('@/lib/meta-conversions-api', {
    namedExports: {
      scheduleEventId: realScheduleEventId,
      sendConversionEvent: async (params: SendConversionCall) => {
        sendConversionCalls.push(params)
        // Espelha o efeito colateral REAL de sendConversionEvent(): ela grava
        // a linha em meta_conversion_events (status 'sent' aqui, já que não
        // chamamos a Graph API de verdade neste mock). Necessário pro teste
        // (g)/FIX 2 abaixo: é essa tabela que o dedup de retry do route.ts
        // consulta antes de decidir se dispara um evento novo.
        await testDb.insert(schema.metaConversionEvents).values({
          companyId: params.companyId,
          leadId: params.leadId,
          eventName: params.eventName,
          eventId: params.eventId,
          status: 'sent',
        })
        return { ok: true }
      },
    },
  })

  mock.module('next/server', {
    namedExports: {
      NextRequest: RealNextRequest,
      NextResponse: RealNextResponse,
      // after() de verdade só funciona dentro do dispatch de requisição do
      // Next; aqui rodamos o callback na hora e guardamos a Promise pro
      // teste poder esperar ela terminar antes de checar as chamadas.
      after: (fn: () => unknown) => {
        capturedAfterPromise = Promise.resolve().then(fn)
      },
    },
  })

  const { POST } = await import('../src/app/api/webhooks/hermes/[slug]/conversion/route')

  function makeRequest(slug: string, body: unknown, opts: { token?: string | null } = {}): InstanceType<typeof RealNextRequest> {
    const url = `https://sac.example.com/api/webhooks/hermes/${slug}/conversion`
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (opts.token !== null) headers['x-webhook-token'] = opts.token ?? TOKEN_CERTO!
    return new RealNextRequest(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  }

  try {
    // ── (a) token errado -> 401, sem tocar no banco ─────────────────────
    await test('token errado -> 401', async () => {
      const before = await testDb.select().from(schema.webhookReceived)
      const req = makeRequest('gramado-plaza-teste', { phone: '5511999998888' }, { token: 'token-errado' })
      const res = await POST(req, { params: Promise.resolve({ slug: 'gramado-plaza-teste' }) })
      assert.equal(res.status, 401)
      const json = await res.json()
      assert.equal(json.error, 'invalid_webhook_token')
      const after1 = await testDb.select().from(schema.webhookReceived)
      assert.equal(after1.length, before.length, 'token errado não deveria gravar nada em webhook_received')
    })

    // ── (a2) token ausente -> 401 ────────────────────────────────────────
    await test('sem token -> 401', async () => {
      const req = makeRequest('gramado-plaza-teste', { phone: '5511999998888' }, { token: null })
      const res = await POST(req, { params: Promise.resolve({ slug: 'gramado-plaza-teste' }) })
      assert.equal(res.status, 401)
    })

    // ── (b) slug de empresa inexistente -> 404 ──────────────────────────
    await test('empresa inexistente -> 404', async () => {
      const req = makeRequest('empresa-que-nao-existe', { phone: '5511999998888' })
      const res = await POST(req, { params: Promise.resolve({ slug: 'empresa-que-nao-existe' }) })
      assert.equal(res.status, 404)
      const json = await res.json()
      assert.equal(json.error, 'Empresa não encontrada')

      const logs = await testDb
        .select()
        .from(schema.webhookReceived)
        .where(eq(schema.webhookReceived.skipReason, 'company_not_found'))
      assert.ok(logs.length >= 1, 'deveria auditar a tentativa em webhook_received mesmo sem achar a empresa')
    })

    // ── (d) phone ausente -> 400 ─────────────────────────────────────────
    await test('sem phone -> 400', async () => {
      const req = makeRequest('gramado-plaza-teste', { nome: 'Sem Telefone' })
      const res = await POST(req, { params: Promise.resolve({ slug: 'gramado-plaza-teste' }) })
      assert.equal(res.status, 400)
    })

    // ── (c) chamada válida -> 200 rápido + sendConversionEvent correto ──
    await test('reserva confirmada válida -> 200 e sendConversionEvent com os parâmetros certos', async () => {
      const phone = '11988887777'
      const started = Date.now()
      const req = makeRequest('gramado-plaza-teste', {
        phone,
        nome: 'Hóspede de Teste',
        valor: 250.5,
        dataReserva: '2026-09-25',
        horario: '20:00',
      })
      const res = await POST(req, { params: Promise.resolve({ slug: 'gramado-plaza-teste' }) })
      const elapsedMs = Date.now() - started

      assert.equal(res.status, 200)
      const json = await res.json()
      assert.deepEqual(json, { ok: true })
      // "rápido": a resposta não espera a Graph API (que nem é chamada de
      // verdade aqui) nem o after() de produção — só a escrita local no
      // Postgres descartável. Generoso o suficiente pra não ser flaky.
      assert.ok(elapsedMs < 2000, `resposta deveria ser rápida, levou ${elapsedMs}ms`)

      await capturedAfterPromise

      assert.equal(sendConversionCalls.length, 1, 'sendConversionEvent deveria ter sido chamado exatamente 1 vez')
      const call = sendConversionCalls[0]
      assert.equal(call.companyId, company.id)
      assert.equal(call.eventName, 'Schedule')
      assert.equal(call.phone, '5511988887777') // formatBrazilianPhone: DDI 55 + nono dígito
      assert.equal(call.value, 250.5)
      assert.equal(call.currency, 'BRL')
      assert.equal(typeof call.leadId, 'number')
      assert.equal(call.eventId, realScheduleEventId(company.id, call.leadId as number, call.eventTime as Date))
      // dataReserva + horario => 2026-09-25T20:00:00-03:00 = 2026-09-25T23:00:00Z
      assert.equal((call.eventTime as Date).toISOString(), '2026-09-25T23:00:00.000Z')

      const [lead] = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.phone, '5511988887777'))
      assert.ok(lead, 'deveria ter criado o lead')
      assert.equal(lead.companyId, company.id)
      assert.equal(lead.platform, 'hermes')
      assert.equal(lead.id, call.leadId)

      const [logRow] = await testDb
        .select()
        .from(schema.webhookReceived)
        .where(eq(schema.webhookReceived.leadId, lead.id))
      assert.ok(logRow, 'deveria ter auditado em webhook_received')
      assert.equal(logRow.processed, true)
      assert.equal(logRow.source, 'hermes')
    })

    // ── (e) segunda reserva confirmada do MESMO telefone -> reaproveita o lead ─
    // dataReserva/horario DIFERENTES da 1ª chamada e presentes nos dois
    // campos: event_id fica determinístico, então este teste valida só a
    // reutilização do lead (comportamento de antes desta rodada de fixes),
    // sem se misturar com o dedup de retry do FIX 2 (que só entra em ação
    // quando dataReserva/horario faltam — ver teste (g) mais abaixo).
    await test('segunda chamada do mesmo telefone reaproveita o lead existente (não duplica)', async () => {
      const phone = '11988887777'
      const totalAntes = (
        await testDb.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.phone, '5511988887777'))
      ).length

      const req = makeRequest('gramado-plaza-teste', {
        phone, valor: 99, dataReserva: '2026-09-26', horario: '19:00',
      })
      const res = await POST(req, { params: Promise.resolve({ slug: 'gramado-plaza-teste' }) })
      assert.equal(res.status, 200)
      await capturedAfterPromise

      const totalDepois = (
        await testDb.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.phone, '5511988887777'))
      ).length
      assert.equal(totalDepois, totalAntes, 'não deveria criar um segundo lead pro mesmo telefone/empresa')

      const ultimaChamada = sendConversionCalls[sendConversionCalls.length - 1]
      assert.equal(ultimaChamada.value, 99)
    })

    // ── (h) FIX 4 (MÉDIO): phone sem dígito suficiente -> 400 ──────────────
    await test('FIX 4: phone tipo "N/A" (sem dígito suficiente) -> 400', async () => {
      const req = makeRequest('gramado-plaza-teste', { phone: 'N/A', nome: 'Sem Telefone Válido' })
      const res = await POST(req, { params: Promise.resolve({ slug: 'gramado-plaza-teste' }) })
      assert.equal(res.status, 400)
      const json = await res.json()
      assert.equal(json.error, 'phone inválido')
    })

    // ── (f) FIX 1 (CRÍTICO): concorrência real com telefone NOVO -> 1 lead só ─
    await test('FIX 1: duas requisições concorrentes com telefone novo criam só 1 lead (sem race condition)', async () => {
      const phone = '11977776666'
      const formattedPhone = '5511977776666'

      const antes = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.phone, formattedPhone))
      assert.equal(antes.length, 0, 'telefone precisa ser novo pro teste fazer sentido')

      const req1 = makeRequest('gramado-plaza-teste', {
        phone, nome: 'Concorrente 1', dataReserva: '2026-09-27', horario: '18:00',
      })
      const req2 = makeRequest('gramado-plaza-teste', {
        phone, nome: 'Concorrente 2', dataReserva: '2026-09-27', horario: '18:00',
      })

      const [res1, res2] = await Promise.all([
        POST(req1, { params: Promise.resolve({ slug: 'gramado-plaza-teste' }) }),
        POST(req2, { params: Promise.resolve({ slug: 'gramado-plaza-teste' }) }),
      ])

      assert.equal(res1.status, 200)
      assert.equal(res2.status, 200)

      const leadsDepois = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.phone, formattedPhone))
      assert.equal(leadsDepois.length, 1, 'concorrência com telefone novo deveria criar exatamente 1 lead, não 2')
    })

    // ── (g) FIX 2 (CRÍTICO): retry sem dataReserva/horario -> 1 disparo só ──
    await test('FIX 2: retry sem dataReserva/horario não duplica o disparo pro Meta', async () => {
      const phone = '11966665555'
      const formattedPhone = '5511966665555'
      const chamadasAntes = sendConversionCalls.length

      const req1 = makeRequest('gramado-plaza-teste', { phone, nome: 'Retry Teste', valor: 180 })
      const res1 = await POST(req1, { params: Promise.resolve({ slug: 'gramado-plaza-teste' }) })
      assert.equal(res1.status, 200)
      await capturedAfterPromise
      assert.equal(sendConversionCalls.length, chamadasAntes + 1, 'primeira chamada deveria disparar o evento')

      // Retry do bot: MESMO telefone, de novo SEM dataReserva/horario —
      // simula reenvio de rede/timeout do lado do bot pro MESMO evento.
      const req2 = makeRequest('gramado-plaza-teste', { phone, nome: 'Retry Teste', valor: 180 })
      const res2 = await POST(req2, { params: Promise.resolve({ slug: 'gramado-plaza-teste' }) })
      assert.equal(res2.status, 200)
      await capturedAfterPromise

      assert.equal(
        sendConversionCalls.length, chamadasAntes + 1,
        'retry do mesmo evento (sem dataReserva/horario) NÃO deveria disparar um segundo evento pro Meta',
      )

      const [lead] = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.phone, formattedPhone))
      assert.ok(lead, 'deveria ter criado/reaproveitado o lead')

      const eventos = await testDb
        .select()
        .from(schema.metaConversionEvents)
        .where(eq(schema.metaConversionEvents.leadId, lead.id))
      assert.equal(eventos.length, 1, 'só deveria existir 1 linha de evento Schedule pro lead, não 2')
    })

    // ── (i) pipelineStage vira 'agendado' pra aparecer no Pipeline ─────────
    // Regressão do achado do Gastão (22/09/2026): leads de Dr. Lucas/Gramado
    // nascem via sync-agents.ts (bloco 3, conversa do agente IA) sem
    // pipelineStage, e o fallback do Pipeline não reconhece
    // eventType='reserva_confirmada'. Este webhook é quem preenche o campo.
    await test('reserva confirmada marca pipelineStage=agendado no lead', async () => {
      const phone = '11955554444'
      const formattedPhone = '5511955554444'
      const req = makeRequest('gramado-plaza-teste', { phone, nome: 'Pipeline Teste', valor: 120 })
      const res = await POST(req, { params: Promise.resolve({ slug: 'gramado-plaza-teste' }) })
      assert.equal(res.status, 200)

      const [lead] = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.phone, formattedPhone))
      assert.ok(lead, 'deveria ter criado o lead')
      assert.equal(lead.pipelineStage, 'agendado')
    })

    // ── (j) nunca regride um card que um humano já fechou manualmente ──────
    await test('reserva confirmada NÃO regride pipelineStage já em fechado', async () => {
      const phone = '11944443333'
      const formattedPhone = '5511944443333'

      // Simula: lead já existe (conversa antiga do bot) e um humano já
      // arrastou o card pra "Fechado / Ganho" no Kanban.
      const [preexisting] = await testDb
        .insert(schema.recoveryLeads)
        .values({
          companyId: company.id,
          platform: 'sac',
          eventType: 'atendimento_ia',
          phone: formattedPhone,
          name: 'Hóspede Já Fechado',
          channel: 'whatsapp',
          status: 'in_conversation',
          pipelineStage: 'fechado',
        })
        .returning()

      const req = makeRequest('gramado-plaza-teste', { phone, nome: 'Hóspede Já Fechado', valor: 50 })
      const res = await POST(req, { params: Promise.resolve({ slug: 'gramado-plaza-teste' }) })
      assert.equal(res.status, 200)

      const [lead] = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.id, preexisting.id))
      assert.equal(lead.pipelineStage, 'fechado', 'não deveria regredir um card já fechado manualmente')
    })

    // ── JSON inválido -> 400, auditado ──────────────────────────────────
    await test('atualização e cancelamento chegam ao SAC sem duplicar conversão Meta', async () => {
      const phone = '11933332222'
      const formattedPhone = '5511933332222'
      const callsBefore = sendConversionCalls.length

      const updateResponse = await POST(makeRequest('gramado-plaza-teste', {
        phone, acao: 'updated', reservaId: 'reserva-sintetica-1', status: 'pendente',
        dataReserva: '2026-09-30', horario: '20:30',
      }), { params: Promise.resolve({ slug: 'gramado-plaza-teste' }) })
      assert.equal(updateResponse.status, 200)
      assert.equal(sendConversionCalls.length, callsBefore)

      const cancelResponse = await POST(makeRequest('gramado-plaza-teste', {
        phone, acao: 'cancelled', reservaId: 'reserva-sintetica-1', status: 'cancelou',
      }), { params: Promise.resolve({ slug: 'gramado-plaza-teste' }) })
      assert.equal(cancelResponse.status, 200)
      assert.equal(sendConversionCalls.length, callsBefore)

      const [lead] = await testDb.select().from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.phone, formattedPhone))
      assert.equal(lead.pipelineStage, 'perdido')
      assert.equal(lead.status, 'cancelled')

      const logs = await testDb.select().from(schema.webhookReceived)
      assert.ok(logs.some(log => log.event === 'reserva_atualizada'))
      assert.ok(logs.some(log => log.event === 'reserva_cancelada'))
    })

    await test('JSON inválido -> 400', async () => {
      const url = 'https://sac.example.com/api/webhooks/hermes/gramado-plaza-teste/conversion'
      const req = new RealNextRequest(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-webhook-token': TOKEN_CERTO! },
        body: '{ isso não é json',
      })
      const res = await POST(req, { params: Promise.resolve({ slug: 'gramado-plaza-teste' }) })
      assert.equal(res.status, 400)
    })
  } finally {
    await sql.end({ timeout: 2 })
    disposable.stop()
  }
}

main()
  .then(() => {
    console.log('\nOK: todos os cenários do webhook de conversão do Hermes rodaram contra Postgres descartável real.')
  })
  .catch(err => {
    console.error('Erro fatal no teste do webhook Hermes:', err)
    process.exitCode = 1
  })
