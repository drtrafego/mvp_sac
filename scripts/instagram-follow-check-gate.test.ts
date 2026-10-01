// Teste do gate de seguidor do Instagram Comment-to-DM (24/09/2026).
//
// Contexto: hoje, comentário com palavra-chave dispara IMEDIATAMENTE o
// dmMessage configurado (uma mensagem só). Esta mudança introduz um flag
// opt-in POR AUTOMAÇÃO (instagramCommentAutomations.requireFollowCheck):
// quando ligado, o fluxo vira DUAS mensagens — pergunta intermediária,
// resposta da pessoa, checagem REAL via Graph API (is_user_follow_business),
// só então o dmMessage real. Automação sem o flag continua idêntica a hoje.
//
// Mesmo padrão de scripts/hermes-conversion-webhook.test.ts: sobe um
// Postgres DESCARTÁVEL via Docker, aplica o schema real via
// `drizzle-kit push`, e substitui por mock só o que precisa:
//   - '@/lib/db': drizzle real contra o Postgres descartável.
//   - '@/lib/instagram': sendInstagramPrivateReply, sendInstagramMessage e
//     checkInstagramUserFollowsBusiness viram espiões controláveis (não fala
//     com a Graph API de verdade). replyInstagramCommentPublic e
//     hideInstagramComment viram no-ops.
//   - '@/lib/ai-reply': generateAndSendAiReply vira espião, pra provar que o
//     caminho normal de IA NUNCA é chamado quando o lead tem checagem de
//     seguidor pendente (item (b) do briefing: reconferir que está
//     REALMENTE bloqueado, não supor).
//   - 'next/server': after() síncrono (mesmo motivo do teste do Hermes).
//
// Casos cobertos (pedidos na tarefa):
//   (a) automação SEM requireFollowCheck -> dmMessage direto, sem mudança
//       nenhuma no comportamento de hoje (regressão do fluxo antigo).
//   (b) automação COM requireFollowCheck -> manda a pergunta intermediária,
//       NÃO o dmMessage; lead fica marcado pendingFollowCheckAutomationId.
//   (c) resposta com is_user_follow_business=true -> libera o dmMessage
//       real e limpa o estado pendente.
//   (d) resposta com is_user_follow_business=false -> manda "segue
//       primeiro" e MANTÉM o estado pendente.
// Mais a prova explícita do item (b) do briefing:
//   (e) lead com checagem pendente que manda outra mensagem NUNCA aciona
//       generateAndSendAiReply (o caminho normal de IA), só
//       handleFollowCheckReply.
//   (f) lead SEM checagem pendente aciona generateAndSendAiReply
//       normalmente (prova que o bloqueio é seletivo, não global).
//   (g) erro da Graph API (token/rede) não decide no escuro: mantém o
//       estado pendente e não manda nada incorreto.
//
// Regressão permanente da 2ª rodada de QA adversarial (24/09/2026), 3
// bugs CRÍTICOS + 1 ALTO reprovaram o PR #59, corrigidos e travados aqui:
//   (h) QA-1 (CRÍTICO): comentário em post B, numa automação SEM o flag, não
//       pode apagar silenciosamente o gate pendente de OUTRA automação (post
//       A, com o flag) da mesma pessoa.
//   (i) QA-2 (CRÍTICO): lead com checagem pendente E botPaused=true não
//       aciona NADA automático (nem o gate, nem a IA) — decisão fica 100%
//       com o humano que pausou.
//   (j) QA-3 (CRÍTICO): duas invocações CONCORRENTES de handleFollowCheckReply
//       pro mesmo lead/automação, ambas com is_user_follow_business=true, só
//       mandam o conteúdo pago UMA vez (claim-then-act, não "manda-então-zera").
//   (k) QA-4 (ALTO): depois de MAX_FOLLOW_CHECK_ATTEMPTS respostas sem
//       confirmar, o gate desiste, grava nota no CRM do lead e devolve a
//       mensagem pro fluxo normal de IA (sem sequestrar a conversa pra sempre).
//
// Uso: npx tsx --experimental-test-module-mocks --test scripts/instagram-follow-check-gate.test.ts

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
const CONTAINER_NAME = 'instagram_follow_check_gate_test'
const APP_SECRET = 'test-instagram-app-secret'

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
    .values({ name: 'Empresa Teste Follow Gate', slug: 'follow-gate-teste' })
    .returning()

  await testDb.insert(schema.settings).values({
    companyId: company.id,
    instagramUsername: 'contaoficial',
    instagramAccessToken: 'fake-ig-token',
    instagramAccountId: 'ACCOUNT_TESTE_123',
    instagramPageId: 'PAGE_TESTE_123',
    instagramAppSecret: APP_SECRET,
  })

  // ─── Mocks (precisam ser registrados ANTES do 1º import dinâmico) ───────
  type PrivateReplyCall = { commentId: string; text: string; companyId: number }
  type SendMessageCall = { recipientId: string; text?: string; companyId: number }
  type FollowCheckCall = { igsid: string; companyId: number }
  type AiReplyCall = { leadId: number }

  const privateReplyCalls: PrivateReplyCall[] = []
  const sendMessageCalls: SendMessageCall[] = []
  const followCheckCalls: FollowCheckCall[] = []
  const aiReplyCalls: AiReplyCall[] = []

  // Controla a resposta de checkInstagramUserFollowsBusiness por teste.
  let followCheckResponse: { ok: boolean; follows?: boolean; error?: string } = { ok: true, follows: false }

  mock.module('@/lib/db', {
    namedExports: { db: testDb },
  })

  mock.module('@/lib/instagram', {
    namedExports: {
      sendInstagramPrivateReply: async (params: PrivateReplyCall) => {
        privateReplyCalls.push(params)
        return { ok: true, messageId: `mid_private_${privateReplyCalls.length}` }
      },
      sendInstagramMessage: async (params: SendMessageCall) => {
        sendMessageCalls.push(params)
        return { ok: true, messageId: `mid_direct_${sendMessageCalls.length}` }
      },
      checkInstagramUserFollowsBusiness: async (params: FollowCheckCall) => {
        followCheckCalls.push(params)
        return followCheckResponse
      },
      replyInstagramCommentPublic: async () => ({ ok: true }),
      hideInstagramComment: async () => ({ ok: true }),
    },
  })

  mock.module('@/lib/ai-reply', {
    namedExports: {
      generateAndSendAiReply: async (leadId: number) => {
        aiReplyCalls.push({ leadId })
      },
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

  const { processInstagramComment, handleFollowCheckReply } = await import('../src/lib/instagram-comment-processor')
  const { POST: instagramWebhookPost } = await import('../src/app/api/webhooks/instagram/[slug]/route')

  function makeInboundDmRequest(igsid: string, text: string, mid: string) {
    const body = {
      object: 'instagram',
      entry: [
        {
          id: 'ACCOUNT_TESTE_123',
          messaging: [
            {
              sender: { id: igsid },
              recipient: { id: 'ACCOUNT_TESTE_123' },
              message: { mid, text },
            },
          ],
        },
      ],
    }
    const rawBody = JSON.stringify(body)
    const url = 'https://sac.example.com/api/webhooks/instagram/follow-gate-teste'
    return new RealNextRequest(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signBody(rawBody),
      },
      body: rawBody,
    })
  }

  try {
    // ── (a) automação SEM requireFollowCheck: dmMessage direto, sem mudança ─
    await test('(a) automação sem requireFollowCheck continua mandando o dmMessage direto (regressão do fluxo antigo)', async () => {
      const [automation] = await testDb
        .insert(schema.instagramCommentAutomations)
        .values({
          companyId: company.id,
          name: '230926 teste dm (sem flag, regressão)',
          keywords: 'QUERO',
          matchType: 'contains',
          dmMessage: 'Aqui está o link que você pediu: https://exemplo.com',
          isActive: true,
          requireFollowCheck: false,
        })
        .returning()

      const commenterId = 'commenter_sem_flag_1'
      const result = await processInstagramComment({
        companyId: company.id,
        commentId: 'comment_sem_flag_1',
        commenterId,
        commenterUsername: 'fulano',
        mediaId: 'media_1',
        commentText: 'QUERO o link',
      })

      assert.equal(result.status, 'sent')
      assert.equal(privateReplyCalls.length, 1)
      assert.equal(privateReplyCalls[0].text, automation.dmMessage, 'sem o flag, o texto enviado tem que ser o dmMessage exato, sem pergunta intermediária')

      const [lead] = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.phone, `ig_${commenterId}`))
      assert.ok(lead, 'deveria ter criado o lead')
      assert.equal(
        lead.pendingFollowCheckAutomationId,
        null,
        'sem o flag, o lead NUNCA deveria entrar no estado de checagem pendente',
      )

      const [msg] = await testDb
        .select()
        .from(schema.whatsappMessages)
        .where(eq(schema.whatsappMessages.leadId, lead.id))
      assert.equal(msg.content, automation.dmMessage)
    })

    // ── (b) automação COM requireFollowCheck: pergunta intermediária, não o dmMessage ─
    let automationComFlagId: number
    let commenterComFlag: string
    await test('(b) automação com requireFollowCheck manda a pergunta intermediária, NÃO o dmMessage, e marca o lead pendente', async () => {
      const [automation] = await testDb
        .insert(schema.instagramCommentAutomations)
        .values({
          companyId: company.id,
          name: 'Automação com gate de seguidor',
          keywords: 'LINK',
          matchType: 'contains',
          dmMessage: 'CONTEÚDO SECRETO: aqui está o material completo.',
          isActive: true,
          requireFollowCheck: true,
        })
        .returning()
      automationComFlagId = automation.id

      commenterComFlag = 'commenter_com_flag_1'
      const result = await processInstagramComment({
        companyId: company.id,
        commentId: 'comment_com_flag_1',
        commenterId: commenterComFlag,
        commenterUsername: 'cicrana',
        mediaId: 'media_2',
        commentText: 'manda o LINK',
      })

      assert.equal(result.status, 'sent')
      assert.equal(privateReplyCalls.length, 2, 'deveria ter mandado 1 mensagem nova (a 1ª já foi do teste (a))')
      const sentText = privateReplyCalls[1].text
      assert.notEqual(sentText, automation.dmMessage, 'com o flag, o conteúdo final NUNCA pode sair na primeira mensagem')
      assert.match(sentText, /segue/i, 'a pergunta intermediária precisa perguntar sobre seguir a conta')

      const [lead] = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.phone, `ig_${commenterComFlag}`))
      assert.ok(lead)
      assert.equal(
        lead.pendingFollowCheckAutomationId,
        automation.id,
        'com o flag, o lead precisa ficar marcado aguardando a checagem desta automação',
      )

      const [msg] = await testDb
        .select()
        .from(schema.whatsappMessages)
        .where(eq(schema.whatsappMessages.leadId, lead.id))
      assert.equal(msg.content, sentText)
    })

    // ── (e) prova direta: resposta de lead com checagem pendente NUNCA cai no
    // generateAndSendAiReply normal (item (b) do briefing, reconferido de
    // verdade via webhook real, não só lendo o código) ──────────────────────
    await test('(e) resposta do lead com checagem pendente NÃO aciona generateAndSendAiReply, só handleFollowCheckReply', async () => {
      followCheckResponse = { ok: true, follows: false } // ainda não segue, pra não interferir no próximo caso

      const aiCallsAntes = aiReplyCalls.length
      const followCallsAntes = followCheckCalls.length

      const req = makeInboundDmRequest(commenterComFlag, 'já sigo!', 'mid_resposta_pendente_1')
      const res = await instagramWebhookPost(req, { params: Promise.resolve({ slug: 'follow-gate-teste' }) })
      assert.equal(res.status, 200)

      await capturedAfterPromise

      assert.equal(
        aiReplyCalls.length,
        aiCallsAntes,
        'generateAndSendAiReply NÃO deveria ter sido chamado pra um lead com checagem de seguidor pendente',
      )
      assert.equal(
        followCheckCalls.length,
        followCallsAntes + 1,
        'handleFollowCheckReply deveria ter chamado checkInstagramUserFollowsBusiness exatamente 1 vez',
      )

      // (d) is_user_follow_business=false -> reforça o pedido e MANTÉM pendente
      assert.equal(sendMessageCalls.length, 1)
      assert.match(sendMessageCalls[0].text ?? '', /segue/i)
      assert.notEqual(sendMessageCalls[0].text, undefined)

      const [lead] = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.phone, `ig_${commenterComFlag}`))
      assert.equal(
        lead.pendingFollowCheckAutomationId,
        automationComFlagId,
        '(d) resposta negativa precisa MANTER o estado pendente pra checar de novo depois',
      )
    })

    // ── (c) segunda resposta, agora com is_user_follow_business=true -> libera ─
    await test('(c) resposta com is_user_follow_business=true libera o dmMessage real e limpa o estado pendente', async () => {
      followCheckResponse = { ok: true, follows: true }
      const aiCallsAntes = aiReplyCalls.length

      const req = makeInboundDmRequest(commenterComFlag, 'agora sigo de verdade', 'mid_resposta_pendente_2')
      const res = await instagramWebhookPost(req, { params: Promise.resolve({ slug: 'follow-gate-teste' }) })
      assert.equal(res.status, 200)

      await capturedAfterPromise

      assert.equal(aiReplyCalls.length, aiCallsAntes, 'ainda não deveria cair na IA normal nesta resposta')

      const [automation] = await testDb
        .select()
        .from(schema.instagramCommentAutomations)
        .where(eq(schema.instagramCommentAutomations.id, automationComFlagId))
      assert.ok(automation)

      const ultimaChamada = sendMessageCalls[sendMessageCalls.length - 1]
      assert.equal(ultimaChamada.text, automation.dmMessage, 'depois de confirmado, o conteúdo real (dmMessage) tem que ser liberado')

      const [lead] = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.phone, `ig_${commenterComFlag}`))
      assert.equal(
        lead.pendingFollowCheckAutomationId,
        null,
        'depois de confirmado que segue, o estado pendente tem que ser limpo',
      )

      // Terceira mensagem do mesmo lead, agora sem checagem pendente: cai
      // normal na IA de novo (prova (f), o bloqueio é seletivo).
      const req2 = makeInboundDmRequest(commenterComFlag, 'valeu!', 'mid_pos_liberacao_1')
      const res2 = await instagramWebhookPost(req2, { params: Promise.resolve({ slug: 'follow-gate-teste' }) })
      assert.equal(res2.status, 200)
      await capturedAfterPromise
      assert.equal(
        aiReplyCalls.length,
        aiCallsAntes + 1,
        '(f) sem checagem pendente, a mensagem seguinte do MESMO lead deveria cair normal na IA',
      )
    })

    // ── (g) erro da Graph API: não decide no escuro, mantém pendente ────────
    await test('(g) erro da Graph API (token/rede) mantém o estado pendente e não libera nem nega errado', async () => {
      const [automation] = await testDb
        .insert(schema.instagramCommentAutomations)
        .values({
          companyId: company.id,
          name: 'Automação com gate — cenário de erro de API',
          keywords: 'PROMO',
          matchType: 'contains',
          dmMessage: 'Conteúdo da promoção.',
          isActive: true,
          requireFollowCheck: true,
        })
        .returning()

      const commenterErro = 'commenter_erro_api_1'
      await processInstagramComment({
        companyId: company.id,
        commentId: 'comment_erro_api_1',
        commenterId: commenterErro,
        commenterUsername: 'erroteste',
        mediaId: 'media_3',
        // Evita de propósito qualquer palavra usada pelas automações dos
        // testes anteriores ('QUERO' do teste (a), 'LINK' do teste (b)):
        // isActive continua true nas duas, e o casamento de palavra-chave
        // roda contra TODAS as automações ativas da empresa, não só a nova.
        commentText: 'me manda a PROMO',
      })

      const [leadAntes] = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.phone, `ig_${commenterErro}`))
      assert.equal(leadAntes.pendingFollowCheckAutomationId, automation.id)

      followCheckResponse = { ok: false, error: 'Erro simulado: token inválido ou rede fora' }

      const sendMessageCallsAntes = sendMessageCalls.length
      const result = await handleFollowCheckReply({
        companyId: company.id,
        leadId: leadAntes.id,
        igsid: commenterErro,
        automationId: automation.id,
      })
      assert.equal(
        result.status,
        'api_error',
        'sem resposta válida da Graph API, não pode fingir que sabe se a pessoa segue ou não',
      )

      assert.equal(
        sendMessageCalls.length,
        sendMessageCallsAntes,
        'erro de API não deveria mandar nenhuma mensagem nova (nem liberar, nem negar)',
      )

      const [leadDepois] = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.id, leadAntes.id))
      assert.equal(
        leadDepois.pendingFollowCheckAutomationId,
        automation.id,
        'erro de API precisa MANTER o estado pendente pra tentar de novo na próxima resposta',
      )
    })

    // ── (h) QA-1 CRÍTICO: automação SEM o flag não pode apagar o gate
    // pendente de OUTRA automação (achado real do QA adversarial na 2ª
    // rodada do PR #59) ──────────────────────────────────────────────────
    await test('(h) QA-1 CRÍTICO: comentário em automação SEM requireFollowCheck NÃO apaga gate pendente de outra automação', async () => {
      const [automationA] = await testDb
        .insert(schema.instagramCommentAutomations)
        .values({
          companyId: company.id,
          name: 'QA-1 Automação A (com flag)',
          keywords: 'GATEA',
          matchType: 'contains',
          dmMessage: 'Conteúdo real da automação A',
          isActive: true,
          requireFollowCheck: true,
        })
        .returning()

      const [automationB] = await testDb
        .insert(schema.instagramCommentAutomations)
        .values({
          companyId: company.id,
          name: 'QA-1 Automação B (sem flag)',
          keywords: 'GATEB',
          matchType: 'contains',
          dmMessage: 'Conteúdo direto da automação B',
          isActive: true,
          requireFollowCheck: false,
        })
        .returning()

      const commenterQa1 = 'commenter_qa1_1'

      // 1. Comenta no post A (automação com o flag): fica pendente em A.
      await processInstagramComment({
        companyId: company.id,
        commentId: 'comment_qa1_post_a',
        commenterId: commenterQa1,
        commenterUsername: 'qa1user',
        mediaId: 'media_qa1_a',
        commentText: 'libera o GATEA',
      })

      const [leadAposA] = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.phone, `ig_${commenterQa1}`))
      assert.equal(leadAposA.pendingFollowCheckAutomationId, automationA.id, 'deveria ficar pendente na automação A')

      // 2. ANTES de responder, comenta no post B (automação SEM o flag).
      // Bug original: isto zerava pendingFollowCheckAutomationId pra null
      // incondicionalmente, mesmo automação B não tendo o flag.
      const resultB = await processInstagramComment({
        companyId: company.id,
        commentId: 'comment_qa1_post_b',
        commenterId: commenterQa1,
        commenterUsername: 'qa1user',
        mediaId: 'media_qa1_b',
        commentText: 'libera o GATEB',
      })
      assert.equal(resultB.status, 'sent')

      const [leadAposB] = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.phone, `ig_${commenterQa1}`))
      assert.equal(
        leadAposB.pendingFollowCheckAutomationId,
        automationA.id,
        'FIX CRÍTICO: automação B SEM o flag não pode ter apagado o gate pendente da automação A',
      )

      // 3. A pessoa responde confirmando que segue: tem que liberar o
      // conteúdo da automação A (a que ela estava realmente respondendo),
      // não ficar perdida/nula.
      followCheckResponse = { ok: true, follows: true }
      const sendCallsAntes = sendMessageCalls.length
      const resultado = await handleFollowCheckReply({
        companyId: company.id,
        leadId: leadAposB.id,
        igsid: commenterQa1,
        automationId: leadAposB.pendingFollowCheckAutomationId!,
      })
      assert.equal(resultado.status, 'released')
      assert.equal(sendMessageCalls.length, sendCallsAntes + 1)
      assert.equal(sendMessageCalls[sendMessageCalls.length - 1].text, automationA.dmMessage)
    })

    // ── (i) QA-2 CRÍTICO: pendente + botPaused não pode disparar NADA
    // automático (nem gate, nem IA) ──────────────────────────────────────
    await test('(i) QA-2 CRÍTICO: lead com checagem pendente E botPaused=true não aciona gate nem IA', async () => {
      const [automation] = await testDb
        .insert(schema.instagramCommentAutomations)
        .values({
          companyId: company.id,
          name: 'QA-2 Automação (bot pausado)',
          keywords: 'GATEPAUSA',
          matchType: 'contains',
          dmMessage: 'Conteúdo que não pode sair sozinho com bot pausado',
          isActive: true,
          requireFollowCheck: true,
        })
        .returning()

      const commenterQa2 = 'commenter_qa2_1'
      await processInstagramComment({
        companyId: company.id,
        commentId: 'comment_qa2_1',
        commenterId: commenterQa2,
        commenterUsername: 'qa2user',
        mediaId: 'media_qa2',
        commentText: 'libera o GATEPAUSA',
      })

      // Atendente humano pausa o bot pra assumir a conversa na mão.
      await testDb
        .update(schema.recoveryLeads)
        .set({ botPaused: true })
        .where(eq(schema.recoveryLeads.phone, `ig_${commenterQa2}`))

      const followCallsAntes = followCheckCalls.length
      const aiCallsAntes = aiReplyCalls.length
      const sendCallsAntes = sendMessageCalls.length

      const req = makeInboundDmRequest(commenterQa2, 'já sigo, pode liberar', 'mid_qa2_1')
      const res = await instagramWebhookPost(req, { params: Promise.resolve({ slug: 'follow-gate-teste' }) })
      assert.equal(res.status, 200)
      await capturedAfterPromise

      assert.equal(
        followCheckCalls.length,
        followCallsAntes,
        'FIX CRÍTICO: com botPaused=true, handleFollowCheckReply NÃO deveria ter sido chamado',
      )
      assert.equal(
        aiReplyCalls.length,
        aiCallsAntes,
        'com botPaused=true, generateAndSendAiReply também NÃO deveria ter sido chamado (é a mesma regra de sempre)',
      )
      assert.equal(sendMessageCalls.length, sendCallsAntes, 'nenhuma mensagem automática deveria ter sido mandada')

      const [leadDepois] = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.phone, `ig_${commenterQa2}`))
      assert.equal(
        leadDepois.pendingFollowCheckAutomationId,
        automation.id,
        'o estado pendente continua intacto, esperando o humano decidir/despausar',
      )
    })

    // ── (j) QA-3 CRÍTICO: corrida real não pode duplicar o conteúdo pago ────
    await test('(j) QA-3 CRÍTICO: duas invocações concorrentes de handleFollowCheckReply só liberam o conteúdo UMA vez', async () => {
      const [automation] = await testDb
        .insert(schema.instagramCommentAutomations)
        .values({
          companyId: company.id,
          name: 'QA-3 Automação (corrida)',
          keywords: 'GATECORRIDA',
          matchType: 'contains',
          dmMessage: 'Conteúdo pago que não pode duplicar',
          isActive: true,
          requireFollowCheck: true,
        })
        .returning()

      const commenterQa3 = 'commenter_qa3_1'
      await processInstagramComment({
        companyId: company.id,
        commentId: 'comment_qa3_1',
        commenterId: commenterQa3,
        commenterUsername: 'qa3user',
        mediaId: 'media_qa3',
        commentText: 'libera o GATECORRIDA',
      })

      const [lead] = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.phone, `ig_${commenterQa3}`))
      assert.equal(lead.pendingFollowCheckAutomationId, automation.id)

      followCheckResponse = { ok: true, follows: true }
      const sendCallsAntes = sendMessageCalls.length

      // Duas invocações "ao mesmo tempo" pro MESMO lead/automação, cenário
      // real de retry ou duplicidade de webhook da Meta entregando a mesma
      // resposta da pessoa duas vezes.
      const [resultado1, resultado2] = await Promise.all([
        handleFollowCheckReply({ companyId: company.id, leadId: lead.id, igsid: commenterQa3, automationId: automation.id }),
        handleFollowCheckReply({ companyId: company.id, leadId: lead.id, igsid: commenterQa3, automationId: automation.id }),
      ])

      const statuses = [resultado1.status, resultado2.status].sort()
      assert.deepEqual(
        statuses,
        ['already_claimed', 'released'],
        'exatamente UMA invocação deveria reivindicar e liberar; a outra desiste sem mandar nada',
      )

      assert.equal(
        sendMessageCalls.length,
        sendCallsAntes + 1,
        'FIX CRÍTICO: o conteúdo pago não pode ser mandado duas vezes numa corrida real',
      )
      assert.equal(sendMessageCalls[sendMessageCalls.length - 1].text, automation.dmMessage)

      const [leadDepois] = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.id, lead.id))
      assert.equal(leadDepois.pendingFollowCheckAutomationId, null)
    })

    // ── (k) QA-4 ALTO: limite de tentativas evita sequestro de conversa ─────
    await test('(k) QA-4 ALTO: depois do limite de tentativas, o gate desiste e devolve a conversa pro fluxo normal de IA', async () => {
      const [automation] = await testDb
        .insert(schema.instagramCommentAutomations)
        .values({
          companyId: company.id,
          name: 'QA-4 Automação (limite de tentativas)',
          keywords: 'GATELIMITE',
          matchType: 'contains',
          dmMessage: 'Conteúdo que nunca deveria ser liberado neste teste',
          isActive: true,
          requireFollowCheck: true,
        })
        .returning()

      const commenterQa4 = 'commenter_qa4_1'
      await processInstagramComment({
        companyId: company.id,
        commentId: 'comment_qa4_1',
        commenterId: commenterQa4,
        commenterUsername: 'qa4user',
        mediaId: 'media_qa4',
        commentText: 'libera o GATELIMITE',
      })

      followCheckResponse = { ok: true, follows: false }
      const aiCallsAntes = aiReplyCalls.length

      // Responde 3 vezes seguidas sem confirmar que segue (nunca clica em
      // seguir de verdade, só responde "não" / manda outra coisa).
      for (let tentativa = 1; tentativa <= 3; tentativa++) {
        const [leadAntes] = await testDb
          .select()
          .from(schema.recoveryLeads)
          .where(eq(schema.recoveryLeads.phone, `ig_${commenterQa4}`))
        const resultado = await handleFollowCheckReply({
          companyId: company.id,
          leadId: leadAntes.id,
          igsid: commenterQa4,
          automationId: automation.id,
        })

        if (tentativa < 3) {
          assert.equal(resultado.status, 'still_pending', `tentativa ${tentativa} deveria continuar pendente`)
        } else {
          assert.equal(
            resultado.status,
            'gate_abandoned_after_max_attempts',
            'na 3ª tentativa sem confirmar, o gate deveria desistir',
          )
        }
      }

      assert.equal(
        aiReplyCalls.length,
        aiCallsAntes + 1,
        'depois de desistir, a mensagem deveria cair no fluxo normal de IA (não fica sem resposta nenhuma)',
      )

      const [leadDepois] = await testDb
        .select()
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.phone, `ig_${commenterQa4}`))
      assert.equal(leadDepois.pendingFollowCheckAutomationId, null, 'gate desistiu: estado pendente tem que estar limpo')
      assert.equal(leadDepois.pendingFollowCheckAttempts, 0, 'contador de tentativas tem que ser zerado ao desistir')
      assert.match(
        leadDepois.notes ?? '',
        /não confirmou seguir/i,
        'tem que sobrar uma nota no CRM do lead explicando por que o gate saiu do ar',
      )
    })
  } finally {
    // Restaura o comportamento padrão do mock antes de qualquer outro teste
    // no processo reaproveitar o módulo (defensivo; este arquivo roda sozinho).
    followCheckResponse = { ok: true, follows: false }
    await sql.end({ timeout: 2 })
    disposable.stop()
  }
}

main()
  .then(() => {
    console.log('\nOK: todos os cenários do gate de seguidor do Instagram Comment-to-DM rodaram contra Postgres descartável real.')
  })
  .catch(err => {
    console.error('Erro fatal no teste do gate de seguidor:', err)
    process.exitCode = 1
  })
