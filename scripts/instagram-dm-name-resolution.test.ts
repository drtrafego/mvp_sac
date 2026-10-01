// Teste do enriquecimento de nome na criação de lead via Instagram DIRECT
// (mensagem direta, não comentário), 26/09/2026.
//
// Contexto: o comentário já chega com `from.username` no próprio payload da
// Meta (instagram-comment-processor.ts usa direto). A mensagem direta (DM)
// NÃO vem com nome/username, só `sender.id` — por isso o lead nascia sempre
// com o placeholder genérico "Instagram Direct (xxxx)". A correção chama
// fetchInstagramUserProfile (Graph API, GET /{sender.id}?fields=name,username)
// ANTES de gravar o placeholder, best-effort: erro/timeout/ausência de nome
// cai no fallback de sempre, nunca lança exceção nem trava a criação do lead.
//
// Mesmo padrão de scripts/instagram-follow-check-gate.test.ts: sobe um
// Postgres DESCARTÁVEL via Docker, aplica o schema real via
// `drizzle-kit push`, e substitui por mock só o que precisa:
//   - '@/lib/db': drizzle real contra o Postgres descartável.
//   - '@/lib/instagram': fetchInstagramUserProfile vira espião controlável
//     (não fala com a Graph API de verdade); os demais exports do módulo
//     (usados transitivamente por instagram-comment-processor.ts) viram
//     no-ops, já que este teste não exercita o fluxo de comentário.
//   - '@/lib/ai-reply': generateAndSendAiReply vira no-op, pra não tentar
//     gerar resposta de IA de verdade depois do 200 (after()).
//   - 'next/server': after() síncrono e capturável (mesmo motivo do teste
//     do gate de seguidor).
//
// Casos cobertos (pedidos na tarefa):
//   (a) Graph API retorna username válido -> lead nasce com "@username".
//   (a2) Graph API retorna só name (sem username) -> lead nasce com o name.
//   (b) Graph API falha (erro de rede/token) -> lead nasce com o placeholder
//       de sempre, SEM lançar exceção (o handler ainda responde 200).
//   (c) Graph API responde ok mas sem name nem username -> mesmo fallback.
// Mais a prova de que o mecanismo retroativo (commit 090cb08, já em main)
// continua funcionando depois desta mudança:
//   (d) lead já existente com o nome genérico recebe nova mensagem -> nome
//       é atualizado pro real na mesma passada (onConflictDoUpdate).
//
// Uso: npx tsx --experimental-test-module-mocks --test scripts/instagram-dm-name-resolution.test.ts

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { createHmac } from 'node:crypto'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'
import { NextRequest as RealNextRequest, NextResponse as RealNextResponse } from 'next/server'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'instagram_dm_name_resolution_test'
const APP_SECRET = 'test-instagram-dm-name-secret'

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

function signBody(rawBody: string): string {
  return 'sha256=' + createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')
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
    .values({ name: 'Empresa Teste DM Name', slug: 'dm-name-teste' })
    .returning()

  await testDb.insert(schema.settings).values({
    companyId: company.id,
    instagramUsername: 'contaoficial',
    instagramAccessToken: 'fake-ig-token',
    instagramAccountId: 'ACCOUNT_DM_NAME_123',
    instagramPageId: 'PAGE_DM_NAME_123',
    instagramAppSecret: APP_SECRET,
  })

  // ─── Mocks (precisam ser registrados ANTES do 1º import dinâmico) ───────
  type ProfileCall = { igsid: string; companyId: number }
  const profileCalls: ProfileCall[] = []

  // Controla a resposta de fetchInstagramUserProfile por teste.
  let profileResponse: { ok: boolean; name?: string; username?: string; error?: string } = { ok: true }

  mock.module('@/lib/db', {
    namedExports: { db: testDb },
  })

  mock.module('@/lib/instagram', {
    namedExports: {
      fetchInstagramUserProfile: async (params: ProfileCall) => {
        profileCalls.push(params)
        return profileResponse
      },
      // Não exercitados neste teste (fluxo de DM, não de comentário), mas
      // precisam existir porque instagram-comment-processor.ts importa do
      // mesmo módulo e é importado transitivamente pela rota.
      sendInstagramPrivateReply: async () => ({ ok: true, messageId: 'mid_private_noop' }),
      sendInstagramMessage: async () => ({ ok: true, messageId: 'mid_direct_noop' }),
      checkInstagramUserFollowsBusiness: async () => ({ ok: true, follows: false }),
      replyInstagramCommentPublic: async () => ({ ok: true }),
      hideInstagramComment: async () => ({ ok: true }),
    },
  })

  mock.module('@/lib/ai-reply', {
    namedExports: {
      generateAndSendAiReply: async () => {},
    },
  })

  let capturedAfterPromise: Promise<unknown> | undefined
  mock.module('next/server', {
    namedExports: {
      NextRequest: RealNextRequest,
      NextResponse: RealNextResponse,
      after: (fn: () => unknown) => {
        capturedAfterPromise = Promise.resolve().then(fn)
      },
    },
  })

  const { POST: instagramWebhookPost } = await import('../src/app/api/webhooks/instagram/route')

  function makeInboundDmRequest(igsid: string, text: string, mid: string) {
    const body = {
      object: 'instagram',
      entry: [
        {
          id: 'ACCOUNT_DM_NAME_123',
          messaging: [
            {
              sender: { id: igsid },
              recipient: { id: 'ACCOUNT_DM_NAME_123' },
              message: { mid, text },
            },
          ],
        },
      ],
    }
    const rawBody = JSON.stringify(body)
    const url = 'https://sac.example.com/api/webhooks/instagram'
    return new RealNextRequest(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signBody(rawBody),
      },
      body: rawBody,
    })
  }

  async function leadByIgsid(igsid: string) {
    const [lead] = await testDb
      .select()
      .from(schema.recoveryLeads)
      .where(eq(schema.recoveryLeads.phone, `ig_${igsid}`))
    return lead
  }

  try {
    // ── (a) Graph API retorna username válido -> "@username" ────────────
    await test('(a) primeira DM de sender novo, Graph API retorna username -> lead nasce com "@username"', async () => {
      profileResponse = { ok: true, name: 'Fulano de Tal', username: 'fulaninho' }
      const igsid = 'sender_com_username_1'

      const req = makeInboundDmRequest(igsid, 'oi, tudo bem?', 'mid_a_1')
      const res = await instagramWebhookPost(req)
      assert.equal(res.status, 200)

      const lead = await leadByIgsid(igsid)
      assert.ok(lead, 'deveria ter criado o lead')
      assert.equal(lead.name, '@fulaninho', 'com username disponível, o nome do lead tem que ser "@username" (username tem prioridade, mesmo padrão visual do fluxo de comentário)')
      assert.equal(profileCalls.length, 1)
      assert.equal(profileCalls[0].igsid, igsid)
    })

    // ── (a2) Graph API retorna só name (sem username) -> usa o name ─────
    await test('(a2) Graph API retorna só name, sem username -> lead nasce com o name real', async () => {
      profileResponse = { ok: true, name: 'Ciclana Sem Username' }
      const igsid = 'sender_so_com_name_1'

      const req = makeInboundDmRequest(igsid, 'oi!', 'mid_a2_1')
      const res = await instagramWebhookPost(req)
      assert.equal(res.status, 200)

      const lead = await leadByIgsid(igsid)
      assert.ok(lead)
      assert.equal(lead.name, 'Ciclana Sem Username', 'sem username, cai pro name')
    })

    // ── (b) Graph API falha (erro de rede/token) -> fallback de sempre ───
    await test('(b) Graph API falha (erro simulado) -> lead nasce com o placeholder de sempre, sem lançar exceção', async () => {
      profileResponse = { ok: false, error: 'Erro simulado: token inválido ou timeout de rede' }
      const igsid = 'sender_erro_api_1'

      const req = makeInboundDmRequest(igsid, 'oi, alguém aí?', 'mid_b_1')
      const res = await instagramWebhookPost(req)
      assert.equal(res.status, 200, 'o webhook precisa continuar respondendo 200 mesmo com a Graph API falhando (enriquecimento é best-effort, não bloqueante)')

      const lead = await leadByIgsid(igsid)
      assert.ok(lead, 'o lead tem que ser criado mesmo com a Graph API falhando')
      assert.equal(
        lead.name,
        `Instagram Direct (${igsid.slice(-4)})`,
        'com erro na Graph API, tem que cair no placeholder genérico de sempre',
      )
    })

    // ── (c) Graph API responde ok mas sem name nem username -> fallback ──
    await test('(c) Graph API responde ok mas sem name nem username -> mesmo fallback', async () => {
      profileResponse = { ok: true }
      const igsid = 'sender_sem_dados_1'

      const req = makeInboundDmRequest(igsid, 'oi', 'mid_c_1')
      const res = await instagramWebhookPost(req)
      assert.equal(res.status, 200)

      const lead = await leadByIgsid(igsid)
      assert.ok(lead)
      assert.equal(lead.name, `Instagram Direct (${igsid.slice(-4)})`)
    })

    // ── (d) mecanismo retroativo (commit 090cb08, já em main) continua ──
    await test('(d) lead existente com nome genérico recebe nova mensagem -> nome é atualizado pro real (mecanismo retroativo já existente)', async () => {
      // Cria o lead "manualmente" já com o placeholder genérico, simulando
      // um lead antigo criado antes desta função existir (ou com a Graph
      // API tendo falhado na 1ª mensagem).
      const igsid = 'sender_retroativo_1'
      profileResponse = { ok: false, error: 'simulando falha na 1ª mensagem' }
      const req1 = makeInboundDmRequest(igsid, 'primeira mensagem', 'mid_d_1')
      const res1 = await instagramWebhookPost(req1)
      assert.equal(res1.status, 200)

      const leadAntes = await leadByIgsid(igsid)
      assert.ok(leadAntes)
      assert.equal(leadAntes.name, `Instagram Direct (${igsid.slice(-4)})`, 'pré-condição: lead nasceu com o placeholder genérico')

      // Segunda mensagem do mesmo sender, agora a Graph API responde certo.
      profileResponse = { ok: true, username: 'retroativouser' }
      const req2 = makeInboundDmRequest(igsid, 'segunda mensagem', 'mid_d_2')
      const res2 = await instagramWebhookPost(req2)
      assert.equal(res2.status, 200)

      const leadDepois = await leadByIgsid(igsid)
      assert.ok(leadDepois)
      assert.equal(
        leadDepois.name,
        '@retroativouser',
        'na 2ª mensagem, com o lead ainda tendo o nome genérico, o mecanismo retroativo já existente (090cb08) tem que ter atualizado pro nome real',
      )
      assert.equal(leadDepois.id, leadAntes.id, 'tem que ser o MESMO lead (upsert), não um novo')
    })
  } finally {
    profileResponse = { ok: true }
    await sql.end({ timeout: 2 })
    disposable.stop()
  }
}

main()
  .then(() => {
    console.log('\nOK: todos os cenários de resolução de nome na DM direta do Instagram rodaram contra Postgres descartável real.')
  })
  .catch(err => {
    console.error('Erro fatal no teste de resolução de nome da DM do Instagram:', err)
    process.exitCode = 1
  })
