// Teste das rotas de tags de lead (25/09/2026):
//   POST   /api/leads/[leadId]/tags        (src/app/api/leads/[leadId]/tags/route.ts)
//   GET    /api/leads/[leadId]/tags
//   DELETE /api/leads/[leadId]/tags/[tag]  (src/app/api/leads/[leadId]/tags/[tag]/route.ts)
//
// Mesmo padrão de scripts/hermes-conversion-webhook.test.ts: sobe um Postgres
// DESCARTÁVEL de verdade via Docker, aplica o schema real via drizzle-kit
// push, e substitui só '@/lib/db' (testDb real) e '@/lib/auth'
// (requireCompany/getCurrentUser determinísticos) por mock.module
// (precisa de --experimental-test-module-mocks). globalThis.fetch é
// monkey-patchado por teste pra controlar a resposta da rota da Luana
// (notifyNaoResponder usa fetch global direto, sem import de módulo próprio,
// então não precisa de mock.module pra isso).
//
// Casos cobertos (pedidos na tarefa):
//   1. Tag comum não mexe em botPaused.
//   2. Tag "pessoa" seta botPaused=true / botPausedBy='tag:pessoa'.
//   3. Remover "pessoa" com botPausedBy='tag:pessoa' reverte a pausa.
//   4. Remover "pessoa" com botPausedBy de outro motivo (simulando o
//      anti-loop de bot-detector.ts) NÃO reverte botPaused nem botPausedBy.
//   5. Chamada à rota da Luana falhando (token ausente, e depois erro de
//      rede) não impede a tag/pausa de serem salvas, só popula `warning`.
// Mais 2 casos de robustez que a própria rota implementa:
//   6. Tag duplicada (mesmo valor, ou variando maiúscula) é idempotente.
//   7. GET lista as tags do lead.
//
// Uso: npx tsx --experimental-test-module-mocks --test scripts/lead-tags.test.ts

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'
import { NextRequest } from 'next/server'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'lead_tags_test'

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

  const [company] = await testDb
    .insert(schema.companies)
    .values({ name: 'Empresa Teste Tags', slug: 'empresa-teste-tags' })
    .returning()

  mock.module('@/lib/db', {
    namedExports: { db: testDb },
  })

  mock.module('@/lib/auth', {
    namedExports: {
      requireCompany: async () => {
        const [c] = await testDb.select().from(schema.companies).where(eq(schema.companies.id, company.id))
        return c
      },
      getCurrentUser: async () => ({ id: 'user-teste', displayName: 'Operador Teste', primaryEmail: 'operador@example.com', isAdmin: false }),
    },
  })

  const { GET, POST } = await import('../src/app/api/leads/[leadId]/tags/route')
  const { DELETE } = await import('../src/app/api/leads/[leadId]/tags/[tag]/route')

  const originalFetch = globalThis.fetch
  const originalToken = process.env.NAO_RESPONDER_TOKEN
  // Token de teste ligado por padrão: só o caso 5a desliga de propósito pra
  // testar o cenário "token ausente" (sem isso, TODOS os testes cairiam
  // nesse mesmo ramo por acidente, e nenhum exercitaria de verdade o
  // sucesso/erro de rede da chamada à Luana).
  process.env.NAO_RESPONDER_TOKEN = 'token-de-teste'

  function mockFetchOk() {
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch
  }
  function mockFetchNetworkError() {
    globalThis.fetch = (async () => {
      throw new Error('fetch failed (simulado): ECONNREFUSED')
    }) as typeof fetch
  }

  async function criarLead(phone: string) {
    const [lead] = await testDb
      .insert(schema.recoveryLeads)
      .values({ companyId: company.id, eventType: 'test', phone, platform: 'sac', channel: 'whatsapp' })
      .returning()
    return lead
  }

  function makePostRequest(leadId: number, tag: string) {
    return new NextRequest(`https://sac.example.com/api/leads/${leadId}/tags`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag }),
    })
  }

  try {
    // ── 1. Tag comum não mexe em botPaused ──────────────────────────────
    await test('tag comum não mexe em botPaused', async () => {
      mockFetchOk()
      const lead = await criarLead('5511911110001')
      const res = await POST(makePostRequest(lead.id, 'vip'), { params: Promise.resolve({ leadId: String(lead.id) }) })
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.equal(json.warning, undefined)

      const [updated] = await testDb.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.id, lead.id))
      assert.equal(updated.botPaused, false)
      assert.equal(updated.botPausedBy, null)

      const tags = await testDb.select().from(schema.leadTags).where(eq(schema.leadTags.leadId, lead.id))
      assert.equal(tags.length, 1)
      assert.equal(tags[0].tag, 'vip')
      assert.equal(tags[0].createdBy, 'Operador Teste')
    })

    // ── 2. Tag "pessoa" pausa o bot ──────────────────────────────────────
    await test('tag "pessoa" seta botPaused=true e botPausedBy=tag:pessoa', async () => {
      mockFetchOk()
      const lead = await criarLead('5511911110002')
      const res = await POST(makePostRequest(lead.id, 'Pessoa'), { params: Promise.resolve({ leadId: String(lead.id) }) }) // maiúscula de propósito
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.equal(json.warning, undefined, 'fetch mockado como sucesso, não deveria ter warning')

      const [updated] = await testDb.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.id, lead.id))
      assert.equal(updated.botPaused, true)
      assert.equal(updated.botPausedBy, 'tag:pessoa')

      const tags = await testDb.select().from(schema.leadTags).where(eq(schema.leadTags.leadId, lead.id))
      assert.equal(tags.length, 1)
      assert.equal(tags[0].tag, 'pessoa', 'normalizada em minúscula mesmo tendo sido enviada como "Pessoa"')
    })

    // ── 6. Tag duplicada é idempotente (mesmo valor e variando maiúscula) ─
    await test('tag duplicada não gera erro nem linha duplicada', async () => {
      mockFetchOk()
      const lead = await criarLead('5511911110003')
      await POST(makePostRequest(lead.id, 'vip'), { params: Promise.resolve({ leadId: String(lead.id) }) })
      const res2 = await POST(makePostRequest(lead.id, 'VIP'), { params: Promise.resolve({ leadId: String(lead.id) }) })
      assert.equal(res2.status, 200)

      const tags = await testDb.select().from(schema.leadTags).where(eq(schema.leadTags.leadId, lead.id))
      assert.equal(tags.length, 1, 'não deveria duplicar a mesma tag normalizada')
    })

    // ── 7. GET lista as tags do lead ─────────────────────────────────────
    await test('GET lista as tags do lead', async () => {
      mockFetchOk()
      const lead = await criarLead('5511911110004')
      await POST(makePostRequest(lead.id, 'vip'), { params: Promise.resolve({ leadId: String(lead.id) }) })
      await POST(makePostRequest(lead.id, 'reincidente'), { params: Promise.resolve({ leadId: String(lead.id) }) })

      const res = await GET(new NextRequest(`https://sac.example.com/api/leads/${lead.id}/tags`), { params: Promise.resolve({ leadId: String(lead.id) }) })
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.equal(json.tags.length, 2)
    })

    // ── 3. Remover "pessoa" com botPausedBy='tag:pessoa' reverte a pausa ──
    await test('remover "pessoa" reverte botPaused quando botPausedBy é tag:pessoa', async () => {
      mockFetchOk()
      const lead = await criarLead('5511911110005')
      await POST(makePostRequest(lead.id, 'pessoa'), { params: Promise.resolve({ leadId: String(lead.id) }) })

      const [antes] = await testDb.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.id, lead.id))
      assert.equal(antes.botPaused, true)

      const res = await DELETE(new NextRequest(`https://sac.example.com/api/leads/${lead.id}/tags/pessoa`, { method: 'DELETE' }), {
        params: Promise.resolve({ leadId: String(lead.id), tag: 'pessoa' }),
      })
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.equal(json.botPaused, false)

      const [depois] = await testDb.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.id, lead.id))
      assert.equal(depois.botPaused, false)
      assert.equal(depois.botPausedBy, null)

      const tags = await testDb.select().from(schema.leadTags).where(eq(schema.leadTags.leadId, lead.id))
      assert.equal(tags.length, 0)
    })

    // ── 4. Remover "pessoa" com botPausedBy de OUTRO motivo não reverte ──
    await test('remover "pessoa" NÃO reverte botPaused quando a pausa é de outro motivo (anti-loop)', async () => {
      mockFetchOk()
      const lead = await criarLead('5511911110006')
      await POST(makePostRequest(lead.id, 'pessoa'), { params: Promise.resolve({ leadId: String(lead.id) }) })

      // Simula o anti-loop (bot-detector.ts) assumindo a pausa DEPOIS,
      // sobrescrevendo o motivo — cenário real: outro código do projeto
      // também escreve botPausedBy, sem saber da tag.
      const motivoAntiLoop = 'Anti-loop (bot do outro lado detectado: saudação, pontos=5)'
      await testDb
        .update(schema.recoveryLeads)
        .set({ botPausedBy: motivoAntiLoop })
        .where(eq(schema.recoveryLeads.id, lead.id))

      const res = await DELETE(new NextRequest(`https://sac.example.com/api/leads/${lead.id}/tags/pessoa`, { method: 'DELETE' }), {
        params: Promise.resolve({ leadId: String(lead.id), tag: 'pessoa' }),
      })
      assert.equal(res.status, 200)
      const json = await res.json()
      // botPaused continua true (estado real do lead), a rota não inventa false.
      assert.equal(json.botPaused, true)

      const [depois] = await testDb.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.id, lead.id))
      assert.equal(depois.botPaused, true, 'não deveria reativar o bot por cima de uma pausa de outro motivo')
      assert.equal(depois.botPausedBy, motivoAntiLoop, 'motivo da pausa alheia precisa sobreviver intacto')

      const tags = await testDb.select().from(schema.leadTags).where(eq(schema.leadTags.leadId, lead.id))
      assert.equal(tags.length, 0, 'a tag em si é removida normalmente, só o efeito colateral no bot é que não reverte')
    })

    // ── 8. CRÍTICO (QA 25/09/2026): race condition (TOCTOU) no DELETE ────
    // notifyNaoResponder() pode levar até 5s de timeout real esperando a
    // rota da Luana. Nesse intervalo, o anti-loop de ai-reply.ts (roda em
    // TODA mensagem inbound, independente de qualquer ação do operador) pode
    // pausar o lead por outro motivo. O bug antigo lia botPausedBy no INÍCIO
    // da função e só checava esse valor em memória depois do await, então o
    // UPDATE final reativava o bot por cima da pausa concorrente. Este teste
    // simula exatamente essa janela: o mock de fetch só resolve DEPOIS de já
    // ter alterado botPausedBy no banco, reproduzindo a corrida real.
    await test('DELETE não reativa o bot se outra coisa pausar concorrentemente durante o await da chamada à Nina', async () => {
      const lead = await criarLead('5511911110011')
      await POST(makePostRequest(lead.id, 'pessoa'), { params: Promise.resolve({ leadId: String(lead.id) }) })

      const [antes] = await testDb.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.id, lead.id))
      assert.equal(antes.botPausedBy, 'tag:pessoa')

      const motivoAntiLoop = 'Anti-loop (bot do outro lado detectado: saudação, pontos=5)'
      globalThis.fetch = (async () => {
        // simula o anti-loop mudando botPausedBy ENQUANTO o DELETE ainda
        // está esperando a resposta desta chamada de rede
        await testDb
          .update(schema.recoveryLeads)
          .set({ botPausedBy: motivoAntiLoop, botPausedAt: new Date() })
          .where(eq(schema.recoveryLeads.id, lead.id))
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }) as typeof fetch

      const res = await DELETE(new NextRequest(`https://sac.example.com/api/leads/${lead.id}/tags/pessoa`, { method: 'DELETE' }), {
        params: Promise.resolve({ leadId: String(lead.id), tag: 'pessoa' }),
      })
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.equal(json.botPaused, true, 'não pode reativar o bot por cima da pausa concorrente do anti-loop (leitura fresca, não o valor otimista de antes do await)')

      const [depois] = await testDb.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.id, lead.id))
      assert.equal(depois.botPaused, true)
      assert.equal(depois.botPausedBy, motivoAntiLoop, 'o motivo da pausa concorrente tem que sobreviver intacto, o CAS não pode ter apagado por cima dele')

      mockFetchOk()
    })

    // ── 9. CRÍTICO (QA 25/09/2026): normalização de telefone perigosa ────
    // Telefone que NÃO é WhatsApp brasileiro legítimo (canal diferente, ou
    // formato fora do que formatBrazilianPhone()/formatPhone() produzem) não
    // pode disparar a chamada à Nina com um número fabricado, e o warning
    // precisa deixar claro que não avisou (não pode ficar em silêncio).
    await test('tag "pessoa" em lead que NÃO é WhatsApp válido: salva a tag/pausa, mas avisa que não notificou a Nina', async () => {
      let fetchCalled = false
      globalThis.fetch = (async () => {
        fetchCalled = true
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }) as typeof fetch

      const [lead] = await testDb
        .insert(schema.recoveryLeads)
        .values({ companyId: company.id, eventType: 'test', phone: 'ig_17841400718350027', platform: 'sac', channel: 'instagram' })
        .returning()

      const res = await POST(makePostRequest(lead.id, 'pessoa'), { params: Promise.resolve({ leadId: String(lead.id) }) })
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.ok(json.warning, 'precisa avisar que não deu pra notificar a Nina')
      assert.equal(fetchCalled, false, 'não pode chamar a rota da Luana com um telefone/canal que não é WhatsApp válido')

      const [updated] = await testDb.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.id, lead.id))
      assert.equal(updated.botPaused, true, 'a pausa no SAC vale por si mesmo sem avisar a Nina')
      assert.equal(updated.botPausedBy, 'tag:pessoa')

      mockFetchOk()
    })

    // ── 10. Caminho feliz continua funcionando: WhatsApp BR legítimo ─────
    await test('tag "pessoa" em WhatsApp brasileiro legítimo continua disparando a chamada à Nina normalmente', async () => {
      let fetchCalled = false
      let fetchBody: unknown = null
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        fetchCalled = true
        fetchBody = init?.body ? JSON.parse(String(init.body)) : null
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }) as typeof fetch

      const lead = await criarLead('5511911110012')
      const res = await POST(makePostRequest(lead.id, 'pessoa'), { params: Promise.resolve({ leadId: String(lead.id) }) })
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.equal(json.warning, undefined, 'caso feliz não deveria ter warning')
      assert.equal(fetchCalled, true, 'WhatsApp BR legítimo tem que continuar chamando a rota da Luana')
      assert.equal((fetchBody as { telefone?: string } | null)?.telefone, '5511911110012')

      mockFetchOk()
    })

    // ── 5a. Token da Luana ausente -> tag salva mesmo assim, com warning ──
    await test('token NAO_RESPONDER_TOKEN ausente: tag e pausa salvam, warning é populado', async () => {
      delete process.env.NAO_RESPONDER_TOKEN
      mockFetchOk() // nem deveria ser chamado sem token, mas garante que não é isso que falha
      const lead = await criarLead('5511911110007')
      const res = await POST(makePostRequest(lead.id, 'pessoa'), { params: Promise.resolve({ leadId: String(lead.id) }) })
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.ok(json.warning, 'deveria vir um warning quando o token não está configurado')

      const [updated] = await testDb.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.id, lead.id))
      assert.equal(updated.botPaused, true, 'a pausa no SAC vale por si, mesmo sem avisar a Nina')
      assert.equal(updated.botPausedBy, 'tag:pessoa')

      process.env.NAO_RESPONDER_TOKEN = originalToken
    })

    // ── 5b. Rede falhando (timeout/erro) na chamada à Luana -> mesmo comportamento ──
    await test('erro de rede na chamada à Luana: tag e pausa salvam, warning é populado', async () => {
      process.env.NAO_RESPONDER_TOKEN = 'token-de-teste'
      mockFetchNetworkError()
      const lead = await criarLead('5511911110008')
      const res = await POST(makePostRequest(lead.id, 'pessoa'), { params: Promise.resolve({ leadId: String(lead.id) }) })
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.ok(json.warning, 'deveria vir um warning quando a chamada à rota da Luana falha')

      const [updated] = await testDb.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.id, lead.id))
      assert.equal(updated.botPaused, true)
      assert.equal(updated.botPausedBy, 'tag:pessoa')

      const tags = await testDb.select().from(schema.leadTags).where(eq(schema.leadTags.leadId, lead.id))
      assert.equal(tags.length, 1)

      process.env.NAO_RESPONDER_TOKEN = originalToken
    })

    // ── 5c. Mesmo erro de rede no DELETE -> tag é removida, warning populado ──
    await test('erro de rede na chamada à Luana durante DELETE: tag é removida mesmo assim', async () => {
      process.env.NAO_RESPONDER_TOKEN = 'token-de-teste'
      mockFetchOk()
      const lead = await criarLead('5511911110009')
      await POST(makePostRequest(lead.id, 'pessoa'), { params: Promise.resolve({ leadId: String(lead.id) }) })

      mockFetchNetworkError()
      const res = await DELETE(new NextRequest(`https://sac.example.com/api/leads/${lead.id}/tags/pessoa`, { method: 'DELETE' }), {
        params: Promise.resolve({ leadId: String(lead.id), tag: 'pessoa' }),
      })
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.ok(json.warning)
      assert.equal(json.botPaused, false, 'reverte normalmente: quem falhou foi só o aviso à Nina, não a lógica local')

      const tags = await testDb.select().from(schema.leadTags).where(eq(schema.leadTags.leadId, lead.id))
      assert.equal(tags.length, 0)

      process.env.NAO_RESPONDER_TOKEN = originalToken
    })

    // ── company scoping: lead de outra empresa -> 404 ────────────────────
    await test('lead de outra empresa -> 404 (não vaza entre empresas)', async () => {
      mockFetchOk()
      const [outraEmpresa] = await testDb.insert(schema.companies).values({ name: 'Outra Empresa', slug: 'outra-empresa-tags' }).returning()
      const [leadAlheio] = await testDb
        .insert(schema.recoveryLeads)
        .values({ companyId: outraEmpresa.id, eventType: 'test', phone: '5511911110010', platform: 'sac' })
        .returning()

      const res = await POST(makePostRequest(leadAlheio.id, 'vip'), { params: Promise.resolve({ leadId: String(leadAlheio.id) }) })
      assert.equal(res.status, 404)
    })
  } finally {
    globalThis.fetch = originalFetch
    process.env.NAO_RESPONDER_TOKEN = originalToken
    await sql.end({ timeout: 2 })
    disposable.stop()
  }
}

main()
  .then(() => {
    console.log('\nOK: todos os cenários das rotas de tags de lead rodaram contra Postgres descartável real.')
  })
  .catch(err => {
    console.error('Erro fatal no teste de tags de lead:', err)
    process.exitCode = 1
  })
