// Teste do disparo "Comentário vira DM" sob "Pausar tudo" na Isabela.
//
// Incidente (12/11/2026): a chave de pausa 'all' da Isabela (ligada de propósito
// em 11/11: a Isabela NÃO conversa) barrava também a DM determinística da regra
// "Comentário vira DM". Decisão do Gastão: o disparo da regra (DM única + resposta
// pública da regra) NÃO é bot e passa pela pausa, na empresa isabela-fanini, só
// para comentário posterior ao corte; resposta de IA/conversa continua barrada.
//
// PGlite real (sem Docker, sem rede). Mocks: '@/lib/db' (drizzle sobre PGlite),
// '@/lib/instagram' (espiões de envio: NADA real é enviado), '@/lib/ai-reply'
// (espião), 'next/server' (after síncrono).
//
// Casos:
//   (1) pausa 'all' + regra casando na Isabela = DM + resposta pública enviadas; lead continua pausado
//   (2) lead pausado em massa ('Administrador (Agente IA)', botPausedAll) também passa
//   (3) pausa por humano no lead = bloqueia; opt-out = bloqueia; tag pessoa = bloqueia; anti-loop = bloqueia
//   (4) outra empresa com pausa 'all' = comportamento atual (ignorado_pausa)
//   (5) comentário antigo / sem data = não dispara; reentrega de comentário já ignorado = skipped
//   (6) resposta no Direct depois da DM continua sem resposta automática (IA e follow check)
//   (7) pausa de canal 'instagram' na Isabela também passa; pausa ligada no meio (recheck) usa a mesma regra
//   (8) puro: avaliação do bypass e corte por ISABELA_FORWARD_ONLY_SINCE
//
// Uso: npm run test:isabela-comentario-dm-pausa

import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mock, test } from 'node:test'
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'
import { createSacTestDatabase } from './sac-test-pglite'
import {
  COMMENT_DM_PAUSE_BYPASS_DEFAULT_CUTOFF_AT,
  evaluateCommentDmPauseBypass,
  getCommentDmPauseBypassCutoff,
} from '../src/lib/instagram-comment-pause-bypass'

const APP_SECRET = 'segredo-local-isabela-comentario'
const IG_ACCOUNT = 'ACCOUNT_ISABELA_TESTE'
const DM_TEXT = 'Oii maravilhosa, aqui está o conteúdo do desafio'
const PUBLIC_TEXT = 'Te mandei no direct!'
// Posterior ao corte padrão (12/11/2026 18:40 BRT) e anterior a ele.
const AFTER_CUTOFF = new Date('2026-11-13T10:00:00-03:00')
const BEFORE_CUTOFF = new Date('2026-11-11T22:00:00-03:00')

async function main() {
  const fixture = await createSacTestDatabase([
    schema.companies, schema.settings, schema.recoveryLeads, schema.whatsappMessages,
    schema.messageJobs, schema.sacAuditEvents, schema.leadTags,
    schema.instagramCommentAutomations, schema.instagramCommentLogs, schema.companyPauseSwitches, schema.webhookReceived, schema.instagramInboundTagRules,
  ])
  const { db, pg } = fixture

  const privateReplies: Array<{ commentId: string; text: string; companyId: number }> = []
  const publicReplies: Array<{ commentId: string; text: string }> = []
  const directMessages: Array<{ recipientId: string; text?: string }> = []
  const followChecks: string[] = []
  const aiReplies: number[] = []
  let timestampLookups = 0
  let failPrivateReply = false
  let timestampResult: { ok: boolean; createdAt?: Date } = { ok: true, createdAt: AFTER_CUTOFF }
  let afterPromise: Promise<unknown> | undefined

  mock.method(globalThis, 'fetch', async () => { throw new Error('Rede proibida no teste') })
  mock.module('@/lib/db', { namedExports: { db } })
  mock.module('next/server', {
    namedExports: { NextRequest, NextResponse, after: (fn: () => unknown) => { afterPromise = Promise.resolve().then(fn) } },
  })
  mock.module('@/lib/nao-responder', { namedExports: { notifyNaoResponder: async () => ({ ok: true }) } })
  mock.module('@/lib/leads', { namedExports: { markLeadContacted: async () => undefined } })
  mock.module('@/lib/ai-reply', { namedExports: { generateAndSendAiReply: async (leadId: number) => { aiReplies.push(leadId) } } })
  mock.module('@/lib/instagram', {
    namedExports: {
      sendInstagramPrivateReply: async (p: { commentId: string; text: string; companyId: number }) => { privateReplies.push(p); return failPrivateReply ? { ok: false, error: 'falha simulada' } : { ok: true, messageId: `mid_${privateReplies.length}` } },
      sendInstagramMessage: async (p: { recipientId: string; text?: string }) => { directMessages.push(p); return { ok: true, messageId: `dm_${directMessages.length}` } },
      checkInstagramUserFollowsBusiness: async (p: { igsid: string }) => { followChecks.push(p.igsid); return { ok: true, follows: true } },
      replyInstagramCommentPublic: async (p: { commentId: string; text: string }) => { publicReplies.push(p); return { ok: true } },
      hideInstagramComment: async () => ({ ok: true }),
      getInstagramCommentCreatedAt: async () => { timestampLookups += 1; return timestampResult },
      fetchInstagramUserProfile: async () => ({ ok: false }),
    },
  })

  const { processInstagramComment, handleFollowCheckReply } = await import('../src/lib/instagram-comment-processor')
  const { POST: instagramWebhookPost } = await import('../src/app/api/webhooks/instagram/[slug]/route')
  const { POST: globalWebhookPost } = await import('../src/app/api/webhooks/instagram/route')
  const { setPauseSwitch } = await import('../src/lib/bot-pause')
  const { captureInstagramInboundInteraction } = await import('../src/lib/instagram-inbound-tags')

  const isabela = { id: 2, name: 'Isabela', slug: 'isabela-fanini' }
  const outra = { id: 3, name: 'Outra Empresa', slug: 'outra-empresa' }

  let nextComment = 0
  const comment = (companyId: number, commenterId: string, extra: { commentCreatedAt?: Date | string; text?: string; commentId?: string; mediaId?: string } = {}) =>
    processInstagramComment({
      companyId, source: 'instagram_webhook',
      commentId: extra.commentId ?? `c_${++nextComment}`, commenterId, commenterUsername: `user${commenterId}`,
      mediaId: extra.mediaId ?? 'media_1', commentText: extra.text ?? 'quero o posicionamento',
      commentCreatedAt: 'commentCreatedAt' in extra ? extra.commentCreatedAt : AFTER_CUTOFF,
    })
  const leadByPhone = async (phone: string) => (await db.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.phone, phone)))[0]
  const logsByStatus = async (status: string) => db.select().from(schema.instagramCommentLogs).where(eq(schema.instagramCommentLogs.status, status))
  const reset = async () => {
    await pg.exec('TRUNCATE recovery_leads, whatsapp_messages, instagram_comment_logs, company_pause_switches, lead_tags, sac_audit_events RESTART IDENTITY')
    privateReplies.length = 0; publicReplies.length = 0; directMessages.length = 0; followChecks.length = 0; aiReplies.length = 0
    timestampLookups = 0; timestampResult = { ok: true, createdAt: AFTER_CUTOFF }; failPrivateReply = false
  }
  const pauseLead = (phone: string, companyId: number, fields: Partial<typeof schema.recoveryLeads.$inferInsert>) =>
    db.insert(schema.recoveryLeads).values({
      companyId, platform: 'instagram', channel: 'instagram', eventType: 'instagram_direct', phone, name: phone,
      status: 'in_conversation', botPaused: true, botPausedAt: new Date(), ...fields,
    })
  const webhookDm = async (igsid: string, text: string, mid: string, slug = isabela.slug) => {
    const raw = JSON.stringify({ object: 'instagram', entry: [{ id: IG_ACCOUNT, messaging: [{ sender: { id: igsid }, recipient: { id: IG_ACCOUNT }, message: { mid, text } }] }] })
    const res = await instagramWebhookPost(new NextRequest(`https://sac.example.com/api/webhooks/instagram/${slug}`, {
      method: 'POST', body: raw,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', APP_SECRET).update(raw).digest('hex') },
    }), { params: Promise.resolve({ slug }) })
    await afterPromise
    afterPromise = undefined
    return res
  }

  try {
    await db.insert(schema.companies).values([isabela, outra])
    for (const c of [isabela, outra]) {
      await db.insert(schema.settings).values({
        companyId: c.id, instagramUsername: `conta${c.id}`, instagramAccessToken: 'fake', instagramAccountId: c.id === isabela.id ? IG_ACCOUNT : `${IG_ACCOUNT}_OUTRA`, instagramAppSecret: APP_SECRET,
      })
      await db.insert(schema.instagramCommentAutomations).values({
        companyId: c.id, name: 'TESTE POSICIONAMENTO', keywords: 'posicionamento, desafio, gostosa', matchType: 'contains',
        dmMessage: DM_TEXT, publicReply: PUBLIC_TEXT, isActive: true, requireFollowCheck: false,
      })
    }

    await test('(8) puro: só a lista, só pausa da chave, só depois do corte; variável de deploy só adianta o corte', () => {
      const sw = { botPaused: true, botPausedBy: 'auto (pausa geral ativa)', botPausedAll: true, botPausedChannel: null }
      const base = { companySlug: 'isabela-fanini', lead: sw, switchBlocking: true, commentCreatedAt: AFTER_CUTOFF, env: {} }
      assert.deepEqual(evaluateCommentDmPauseBypass(base), { bypass: true })
      assert.deepEqual(evaluateCommentDmPauseBypass({ ...base, lead: null }), { bypass: true }, 'lead ainda inexistente: só vale a chave')
      for (const slug of ['outra-empresa', 'autonomia', 'gramado-plaza', null, undefined, '']) {
        assert.deepEqual(evaluateCommentDmPauseBypass({ ...base, companySlug: slug }), { bypass: false, reason: 'empresa_fora_da_lista' }, String(slug))
      }
      const individual = [
        { botPaused: true, botPausedBy: 'Atendente Maria', botPausedAll: false, botPausedChannel: null },
        { botPaused: true, botPausedBy: 'optout_whatsapp', botPausedAll: true, botPausedChannel: null },
        { botPaused: true, botPausedBy: 'revisao_possivel_optout', botPausedAll: false, botPausedChannel: 'instagram' },
        { botPaused: true, botPausedBy: 'tag:pessoa', botPausedAll: true, botPausedChannel: null },
        { botPaused: true, botPausedBy: 'Anti-loop (bot do outro lado detectado)', botPausedAll: false, botPausedChannel: null },
        { botPaused: true, botPausedBy: null, botPausedAll: null, botPausedChannel: null },
      ]
      for (const lead of individual) {
        assert.deepEqual(evaluateCommentDmPauseBypass({ ...base, lead }), { bypass: false, reason: 'pausa_individual_do_lead' }, JSON.stringify(lead))
      }
      assert.deepEqual(evaluateCommentDmPauseBypass({ ...base, switchBlocking: false }), { bypass: false, reason: 'pausa_do_lead_sem_chave_ativa' })
      assert.deepEqual(evaluateCommentDmPauseBypass({ ...base, commentCreatedAt: BEFORE_CUTOFF }), { bypass: false, reason: 'comentario_anterior_ao_corte' })
      assert.deepEqual(evaluateCommentDmPauseBypass({ ...base, commentCreatedAt: new Date(COMMENT_CUTOFF_MS - 1) }), { bypass: false, reason: 'comentario_anterior_ao_corte' })
      assert.deepEqual(evaluateCommentDmPauseBypass({ ...base, commentCreatedAt: new Date(COMMENT_CUTOFF_MS) }), { bypass: true })
      assert.deepEqual(evaluateCommentDmPauseBypass({ ...base, commentCreatedAt: null }), { bypass: false, reason: 'comentario_sem_data' })
      assert.deepEqual(evaluateCommentDmPauseBypass({ ...base, commentCreatedAt: new Date('invalid') }), { bypass: false, reason: 'comentario_sem_data' })

      assert.equal(getCommentDmPauseBypassCutoff({})?.getTime(), COMMENT_CUTOFF_MS)
      assert.equal(getCommentDmPauseBypassCutoff({ ISABELA_FORWARD_ONLY_SINCE: '2026-11-14T09:00:00-03:00' })?.toISOString(), new Date('2026-11-14T09:00:00-03:00').toISOString())
      assert.equal(getCommentDmPauseBypassCutoff({ ISABELA_FORWARD_ONLY_SINCE: '2026-01-01T00:00:00Z' })?.getTime(), COMMENT_CUTOFF_MS, 'variável nunca recua o corte')
      assert.equal(getCommentDmPauseBypassCutoff({ ISABELA_FORWARD_ONLY_SINCE: 'amanha' }), null)
      assert.deepEqual(
        evaluateCommentDmPauseBypass({ ...base, env: { ISABELA_FORWARD_ONLY_SINCE: 'amanha' } }),
        { bypass: false, reason: 'corte_invalido' },
        'variável inválida falha fechada',
      )
      assert.deepEqual(
        evaluateCommentDmPauseBypass({ ...base, commentCreatedAt: AFTER_CUTOFF, env: { ISABELA_FORWARD_ONLY_SINCE: '2026-11-14T09:00:00-03:00' } }),
        { bypass: false, reason: 'comentario_anterior_ao_corte' },
      )
    })

    await test('(1) pausa geral ligada: o comentário na Isabela manda a DM e a resposta pública da regra, e o lead continua pausado', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: true, by: 'Gastão', reason: 'Isabela não conversa' })
      await captureInstagramInboundInteraction({ companyId: isabela.id, instagramUserId: '1001', username: 'user1001', interaction: 'comment' })
      const lead = await leadByPhone('ig_1001')
      assert.equal(lead.botPaused, true, 'lead nasce com a pausa herdada da chave')
      assert.equal(lead.botPausedBy, 'auto (pausa geral ativa)')

      const result = await comment(isabela.id, '1001')
      assert.equal(result.status, 'sent')
      assert.equal(privateReplies.length, 1)
      assert.equal(privateReplies[0].text, DM_TEXT, 'sai exatamente a DM configurada na regra')
      assert.equal(publicReplies.length, 1)
      assert.equal(publicReplies[0].text, PUBLIC_TEXT)
      assert.equal(directMessages.length, 0, 'nenhuma mensagem de conversa')
      assert.equal(aiReplies.length, 0, 'IA nunca acionada')

      const after = await leadByPhone('ig_1001')
      assert.equal(after.botPaused, true, 'a pausa NÃO é desligada pelo bypass')
      assert.equal(after.botPausedAll, true)
      assert.equal((await logsByStatus('sent')).length, 1)
      assert.equal((await logsByStatus('ignorado_pausa')).length, 0)
      const audits = await db.select().from(schema.sacAuditEvents)
      assert.equal(audits.filter(a => a.type === 'instagram_comment_dm_pause_bypass').length, 1, 'o bypass fica auditado')
      const sw = await db.select().from(schema.companyPauseSwitches)
      assert.equal(sw[0].active, true, 'a chave continua ligada')
    })

    await test('(1b) comentarista sem lead ainda, pausa geral ligada: manda a DM e o lead nascido depois herda a pausa', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: true, by: 'Gastão' })
      const result = await comment(isabela.id, '1002')
      assert.equal(result.status, 'sent')
      assert.equal(privateReplies.length, 1)
      const lead = await leadByPhone('ig_1002')
      assert.equal(lead.botPaused, true)
      assert.equal(lead.botPausedBy, 'auto (pausa geral ativa)')
    })

    await test('(2) lead pausado em massa pelo "Pausar tudo" (Administrador) também recebe a DM', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: true, by: 'Gastão' })
      await pauseLead('ig_1003', isabela.id, { botPausedBy: 'Administrador (Agente IA)', botPausedAll: true })
      await pauseLead('ig_1004', isabela.id, { botPausedBy: 'Administrador (Agente IA)', botPausedAll: false, botPausedChannel: 'instagram' })
      assert.equal((await comment(isabela.id, '1003')).status, 'sent')
      assert.equal((await comment(isabela.id, '1004')).status, 'sent')
      assert.equal(privateReplies.length, 2)
    })

    await test('(3) pausa individual no lead bloqueia: humano, opt-out, tag pessoa e anti-loop (mesmo com a chave ligada)', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: true, by: 'Gastão' })
      const cases: Array<[string, Partial<typeof schema.recoveryLeads.$inferInsert>]> = [
        ['2001', { botPausedBy: 'Atendente Maria', botPausedAll: false, botPausedChannel: null }],
        ['2002', { botPausedBy: 'optout_whatsapp', botPausedAll: true }],
        ['2003', { botPausedBy: 'tag:pessoa', botPausedAll: true }],
        ['2004', { botPausedBy: 'Anti-loop (bot do outro lado detectado)', botPausedAll: false }],
      ]
      for (const [id, fields] of cases) await pauseLead(`ig_${id}`, isabela.id, fields)
      for (const [id] of cases) {
        const result = await comment(isabela.id, id)
        assert.equal(result.status, 'ignored', id)
        assert.equal(result.reason, 'ignorado_pausa', id)
      }
      assert.equal(privateReplies.length, 0)
      assert.equal(publicReplies.length, 0)
      assert.equal((await logsByStatus('ignorado_pausa')).length, 4)
    })

    await test('(3b) lead pausado por humano SEM chave ligada continua barrado (pausa individual é do lead)', async () => {
      await reset()
      await pauseLead('ig_2101', isabela.id, { botPausedBy: 'Atendente Maria', botPausedAll: false })
      await pauseLead('ig_2102', isabela.id, { botPausedBy: 'Administrador (Agente IA)', botPausedAll: true })
      assert.equal((await comment(isabela.id, '2101')).reason, 'ignorado_pausa')
      assert.equal((await comment(isabela.id, '2102')).reason, 'ignorado_pausa', 'pausa residual sem a chave ligada não é contornada')
      assert.equal(privateReplies.length, 0)
    })

    await test('(4) outra empresa com pausa geral: comportamento atual preservado (nada enviado, ignorado_pausa)', async () => {
      await reset()
      await setPauseSwitch({ companyId: outra.id, scope: 'all', active: true, by: 'Gastão' })
      await captureInstagramInboundInteraction({ companyId: outra.id, instagramUserId: '3001', username: 'user3001', interaction: 'comment' })
      const result = await comment(outra.id, '3001')
      assert.equal(result.status, 'ignored')
      assert.equal(result.reason, 'ignorado_pausa')
      const result2 = await comment(outra.id, '3002')
      assert.equal(result2.reason, 'ignorado_pausa', 'lead novo também')
      assert.equal(privateReplies.length, 0)
      assert.equal(publicReplies.length, 0)
      assert.equal(timestampLookups, 0, 'fora da lista nem consulta timestamp')
      // pausa na outra empresa não vaza para a Isabela, e a da Isabela não vaza para a outra
      assert.equal((await comment(isabela.id, '3003')).status, 'sent', 'Isabela sem chave ligada: fluxo normal')
    })

    await test('(5) comentário antigo ou sem data não dispara; reentrega do já ignorado não reprocessa', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: true, by: 'Gastão' })

      const old = await comment(isabela.id, '4001', { commentCreatedAt: BEFORE_CUTOFF, commentId: 'c_antigo' })
      assert.equal(old.reason, 'ignorado_pausa', 'anterior ao corte: pausa mantida')
      assert.equal(privateReplies.length, 0)
      assert.equal((await logsByStatus('ignorado_pausa')).length, 1)

      // Meta reentrega o MESMO comentário já ignorado, agora com timestamp "novo": idempotência segura.
      const again = await comment(isabela.id, '4001', { commentCreatedAt: AFTER_CUTOFF, commentId: 'c_antigo' })
      assert.equal(again.status, 'skipped')
      assert.equal(again.reason, 'comment_already_processed')
      assert.equal(privateReplies.length, 0)

      // sem timestamp no evento e a Graph não devolve: falha fechada
      timestampResult = { ok: false }
      const noDate = await comment(isabela.id, '4002', { commentCreatedAt: undefined })
      assert.equal(noDate.reason, 'ignorado_pausa')
      assert.equal(timestampLookups >= 1, true)
      // sem timestamp no evento, mas a Graph devolve data recente: passa
      timestampResult = { ok: true, createdAt: AFTER_CUTOFF }
      const viaGraph = await comment(isabela.id, '4003', { commentCreatedAt: undefined })
      assert.equal(viaGraph.status, 'sent')
      assert.equal(privateReplies.length, 1)
    })

    await test('(6) resposta da pessoa no Direct depois da DM segue SEM resposta automática (IA e checagem de seguidor)', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: true, by: 'Gastão' })
      // a pessoa comentou: o webhook cria o lead (pausa herdada) e a DM sai
      await captureInstagramInboundInteraction({ companyId: isabela.id, instagramUserId: '5001', username: 'user5001', interaction: 'comment' })
      assert.equal((await comment(isabela.id, '5001')).status, 'sent')
      assert.equal(privateReplies.length, 1)

      // e então responde no Direct
      const res = await webhookDm('5001', 'oi, quero saber mais', 'mid_resp_1')
      assert.equal(res.status, 200)
      assert.equal(aiReplies.length, 0, 'a IA não responde: a pausa continua valendo')
      assert.equal(directMessages.length, 0)
      assert.equal(followChecks.length, 0)
      const lead = await leadByPhone('ig_5001')
      assert.equal(lead.botPaused, true)

      // o gate de seguidor também não age
      const follow = await handleFollowCheckReply({ companyId: isabela.id, leadId: lead.id, igsid: '5001', automationId: 1 })
      assert.equal(follow.status, 'ignorado_pausa')
      assert.equal(directMessages.length, 0)
      assert.equal(privateReplies.length, 1, 'nenhuma DM além da única da regra')
    })

    await test('(7) pausa só do canal Instagram na Isabela também passa; WhatsApp ligado não muda nada', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'instagram', active: true, by: 'Gastão' })
      assert.equal((await comment(isabela.id, '6001')).status, 'sent')
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'whatsapp', active: true, by: 'Gastão' })
      assert.equal((await comment(isabela.id, '6002')).status, 'sent', 'sem pausa no canal Instagram: fluxo normal')
      assert.equal((await logsByStatus('ignorado_pausa')).length, 0)
    })

    await test('(7b) o mesmo comentário não dispara duas vezes (claim + dedup por mídia continuam valendo)', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: true, by: 'Gastão' })
      assert.equal((await comment(isabela.id, '7001', { commentId: 'c_dup' })).status, 'sent')
      assert.equal((await comment(isabela.id, '7001', { commentId: 'c_dup' })).reason, 'comment_already_processed')
      // outro comentário da mesma pessoa no mesmo post: já recebeu a DM
      const second = await comment(isabela.id, '7001')
      assert.equal(second.reason, 'already_sent_for_this_media')
      assert.equal(privateReplies.length, 1)
    })

    // ── Correções do QA independente (3 defeitos provados no commit 2eac09f) ──

    const hook = async (path: string, body: unknown, slug?: string) => {
      const raw = JSON.stringify(body)
      const req = new NextRequest(`https://sac.example.com${path}`, {
        method: 'POST', body: raw,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', APP_SECRET).update(raw).digest('hex') },
      })
      const res = slug ? await instagramWebhookPost(req, { params: Promise.resolve({ slug }) }) : await globalWebhookPost(req)
      await afterPromise
      afterPromise = undefined
      return res
    }
    // Formato do payload REAL (webhook_received 70810), identificadores mascarados: o value do
    // comentário NÃO traz timestamp; só entry.time (segundos).
    const realCommentPayload = (commenterId: string, commentId: string, timeSeconds: number, mediaId = 'media_1') => ({
      object: 'instagram',
      entry: [{
        id: IG_ACCOUNT, time: timeSeconds,
        changes: [{ field: 'comments', value: { id: commentId, from: { id: commenterId, username: 'usuario_mascarado' }, text: 'posicionamento', media: { id: mediaId, media_product_type: 'REELS' } } }],
      }],
    })
    const AFTER_SECONDS = Math.floor(AFTER_CUTOFF.getTime() / 1000)
    const BEFORE_SECONDS = Math.floor(BEFORE_CUTOFF.getTime() / 1000)

    await test('(QA1) tag "pessoa" em lead já pausado pela chave bloqueia (a tag não sobrescreve a origem da pausa)', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: true, by: 'Gastão' })
      await pauseLead('ig_8101', isabela.id, { botPausedBy: 'auto (pausa geral ativa)', botPausedAll: true })
      await pauseLead('ig_8102', isabela.id, { botPausedBy: 'Administrador (Agente IA)', botPausedAll: false, botPausedChannel: 'instagram' })
      await pauseLead('ig_8103', isabela.id, { botPausedBy: 'auto (pausa geral ativa)', botPausedAll: true })
      const l1 = await leadByPhone('ig_8101'); const l2 = await leadByPhone('ig_8102')
      await db.insert(schema.leadTags).values({ leadId: l1.id, tag: 'pessoa', scopeChannel: null, createdBy: 'humano' })
      await db.insert(schema.leadTags).values({ leadId: l2.id, tag: 'pessoa', scopeChannel: 'instagram', createdBy: 'humano' })
      // pauseBotForPessoaTag real: lead já pausado, a origem da pausa continua a da chave
      const { pauseBotForPessoaTag } = await import('../src/lib/pessoa-tag-pause')
      await pauseBotForPessoaTag({ id: l1.id, phone: l1.phone, channel: l1.channel })
      assert.equal((await leadByPhone('ig_8101')).botPausedBy, 'auto (pausa geral ativa)', 'premissa do defeito: a origem NÃO vira tag:pessoa')

      assert.equal((await comment(isabela.id, '8101')).reason, 'ignorado_pausa', 'tag geral')
      assert.equal((await comment(isabela.id, '8102')).reason, 'ignorado_pausa', 'tag no escopo instagram')
      assert.equal(privateReplies.length, 0)
      assert.equal(publicReplies.length, 0)
      // outra pessoa, sem a tag, na mesma empresa e mesma chave: passa
      assert.equal((await comment(isabela.id, '8103')).status, 'sent')
      assert.equal(privateReplies.length, 1)
      assert.deepEqual(
        evaluateCommentDmPauseBypass({
          companySlug: 'isabela-fanini', switchBlocking: true, commentCreatedAt: AFTER_CUTOFF, env: {},
          lead: { botPaused: true, botPausedBy: 'auto (pausa geral ativa)', botPausedAll: true, hasPessoaTag: true },
        }),
        { bypass: false, reason: 'pausa_individual_do_lead' },
      )
    })

    await test('(QA2) ignorado_pausa antigo na mesma mídia NÃO barra o comentário novo da mesma pessoa: sai 1 DM', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: true, by: 'Gastão' })
      const old = await comment(isabela.id, '8201', { commentCreatedAt: BEFORE_CUTOFF, commentId: 'c_old_8201', mediaId: 'mediaX' })
      assert.equal(old.reason, 'ignorado_pausa')
      assert.equal(privateReplies.length, 0)

      const novo = await comment(isabela.id, '8201', { commentCreatedAt: AFTER_CUTOFF, commentId: 'c_new_8201', mediaId: 'mediaX' })
      assert.equal(novo.status, 'sent', JSON.stringify(novo))
      assert.equal(privateReplies.length, 1)
      assert.equal(privateReplies[0].commentId, 'c_new_8201')
      assert.equal(publicReplies.length, 1)
      const logs = await db.select().from(schema.instagramCommentLogs)
      assert.equal(logs.length, 1, 'a mesma linha é reaproveitada (índice único preservado)')
      assert.equal(logs[0].status, 'sent')
      assert.equal(logs[0].commentId, 'c_new_8201')

      // o comentário antigo reentregue continua sendo "já processado"? o id antigo foi substituído; o corte o barra
      const again = await comment(isabela.id, '8201', { commentCreatedAt: BEFORE_CUTOFF, commentId: 'c_old_8201', mediaId: 'mediaX' })
      assert.equal(privateReplies.length, 1, 'o comentário antigo nunca dispara')
      assert.notEqual(again.status, 'sent')
      // quem já recebeu não recebe de novo (outro comentário depois)
      const third = await comment(isabela.id, '8201', { commentId: 'c_third_8201', mediaId: 'mediaX' })
      assert.equal(third.reason, 'already_sent_for_this_media')
      assert.equal(privateReplies.length, 1)
    })

    await test('(QA2b) três entregas concorrentes do mesmo comentário novo (com ignorado_pausa antigo ocupando a vaga) = 1 DM e 1 resposta pública', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: true, by: 'Gastão' })
      await comment(isabela.id, '8202', { commentCreatedAt: BEFORE_CUTOFF, commentId: 'c_old_8202', mediaId: 'mediaX' })
      const rs = await Promise.all([1, 2, 3].map(() => comment(isabela.id, '8202', { commentId: 'c_new_8202', mediaId: 'mediaX' })))
      assert.equal(rs.filter(r => r.status === 'sent').length, 1, JSON.stringify(rs))
      assert.equal(privateReplies.length, 1)
      assert.equal(publicReplies.length, 1)
      // e sem linha antiga: mesma garantia
      const rs2 = await Promise.all([1, 2, 3].map(() => comment(isabela.id, '8203', { commentId: 'c_new_8203', mediaId: 'mediaX' })))
      assert.equal(rs2.filter(r => r.status === 'sent').length, 1, JSON.stringify(rs2))
      assert.equal(privateReplies.length, 2)
      assert.equal(publicReplies.length, 2)
    })

    await test('(QA2c) só ignorado_pausa é reaproveitável: failed/sent/processing seguem barrando; outra empresa mantém o comportamento atual', async () => {
      await reset()
      const [rule] = await db.select().from(schema.instagramCommentAutomations).where(eq(schema.instagramCommentAutomations.companyId, isabela.id))
      for (const status of ['failed', 'sent', 'processing', 'skipped']) {
        const id = `82${status.length}${status[0]}`
        await db.insert(schema.instagramCommentLogs).values({
          companyId: isabela.id, automationId: rule.id, commentId: `c_prev_${status}`, commenterId: id, mediaId: 'mediaZ',
          commentText: 'posicionamento', status, ...(status === 'sent' ? { sentAt: new Date() } : {}),
        })
        const r = await comment(isabela.id, id, { commentId: `c_next_${status}`, mediaId: 'mediaZ' })
        assert.notEqual(r.status, 'sent', status)
      }
      assert.equal(privateReplies.length, 0)
      const statuses = (await db.select().from(schema.instagramCommentLogs)).map(l => l.status).sort()
      assert.deepEqual(statuses, ['failed', 'processing', 'sent', 'skipped'], 'nenhuma linha foi reaproveitada')

      // outra empresa: ignorado_pausa antigo + pausa desligada depois = continua barrado (comportamento atual)
      await reset()
      await setPauseSwitch({ companyId: outra.id, scope: 'all', active: true, by: 'Gastão' })
      assert.equal((await comment(outra.id, '8290', { commentId: 'o_old', mediaId: 'mediaX' })).reason, 'ignorado_pausa')
      await setPauseSwitch({ companyId: outra.id, scope: 'all', active: false, by: 'Gastão' })
      const r = await comment(outra.id, '8290', { commentId: 'o_new', mediaId: 'mediaX' })
      assert.equal(r.status, 'skipped')
      assert.equal(r.reason, 'comment_claim_already_exists')
      assert.equal(privateReplies.length, 0)
    })

    await test('(QA3) payload real SEM timestamp no value: as duas rotas usam entry.time e enviam com a Graph FALHANDO (comentário após o corte)', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: true, by: 'Gastão' })
      timestampResult = { ok: false }
      const r1 = await hook(`/api/webhooks/instagram/${isabela.slug}`, realCommentPayload('8301', 'c_real_slug', AFTER_SECONDS), isabela.slug)
      assert.equal(r1.status, 200)
      assert.equal(privateReplies.length, 1, 'rota [slug]: 1 DM')
      assert.equal(publicReplies.length, 1)
      const r2 = await hook('/api/webhooks/instagram', realCommentPayload('8302', 'c_real_global', AFTER_SECONDS))
      assert.equal(r2.status, 200)
      assert.equal(privateReplies.length, 2, 'rota global: 1 DM')
      assert.equal(timestampLookups, 0, 'a Graph nem foi necessária')

      // entry.time anterior ao corte: não dispara nas duas rotas
      await hook(`/api/webhooks/instagram/${isabela.slug}`, realCommentPayload('8303', 'c_real_old_slug', BEFORE_SECONDS), isabela.slug)
      await hook('/api/webhooks/instagram', realCommentPayload('8304', 'c_real_old_global', BEFORE_SECONDS))
      assert.equal(privateReplies.length, 2)
      assert.equal((await logsByStatus('ignorado_pausa')).length, 2)
    })

    await test('(QA3b) sem entry.time nem timestamp, a Graph continua como reserva (e falhando nega)', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: true, by: 'Gastão' })
      const semTempo = (commenterId: string, commentId: string) => {
        const p = realCommentPayload(commenterId, commentId, 0)
        delete (p.entry[0] as { time?: number }).time
        return p
      }
      timestampResult = { ok: true, createdAt: AFTER_CUTOFF }
      await hook('/api/webhooks/instagram', semTempo('8311', 'c_sem_tempo_ok'))
      assert.equal(privateReplies.length, 1)
      assert.equal(timestampLookups, 1)
      timestampResult = { ok: false }
      await hook('/api/webhooks/instagram', semTempo('8312', 'c_sem_tempo_falha'))
      assert.equal(privateReplies.length, 1, 'Graph falhando e sem data: falha fechada')
    })

    await test('(QA4) auditoria do bypass só depois do envio bem-sucedido', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: true, by: 'Gastão' })
      failPrivateReply = true
      assert.equal((await comment(isabela.id, '8401')).status, 'failed')
      const audits = async () => (await db.select().from(schema.sacAuditEvents)).filter(a => a.type === 'instagram_comment_dm_pause_bypass').length
      assert.equal(await audits(), 0, 'DM que falhou não gera auditoria de disparo liberado')
      failPrivateReply = false
      assert.equal((await comment(isabela.id, '8402')).status, 'sent')
      assert.equal(await audits(), 1)
    })
  } finally {
    await fixture.close()
  }
}

const COMMENT_CUTOFF_MS = COMMENT_DM_PAUSE_BYPASS_DEFAULT_CUTOFF_AT.getTime()

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
