// Teste da chave persistente de pausa do bot (company_pause_switches).
//
// Incidente: "Pausar tudo" e "Pausar canal" só marcavam os leads que JÁ
// existiam. Lead novo nascia despausado e o comentário automático do
// Instagram (processInstagramComment) não consultava pausa nenhuma. Agora a
// pausa é uma chave da empresa por escopo (all | whatsapp | instagram | email)
// que vale para leads existentes E futuros.
//
// PGlite real (sem Docker, sem rede): tabelas criadas a partir do schema de
// produção; as rotas e o processador rodam de verdade. Só viram mock:
//   - '@/lib/db': drizzle sobre o PGlite;
//   - '@/lib/instagram': espiões de envio (não fala com a Graph API);
//   - '@/lib/ai-reply': espião (a IA real é proibida aqui);
//   - '@/lib/agent-auth' e '@/lib/auth': contexto fixo + gravador de auditoria;
//   - 'next/server': after() síncrono.
//
// Casos (pedidos na tarefa):
//   (1) comentário com pausa ativa NÃO envia e registra 'ignorado_pausa'
//   (2) lead novo com a chave ativa nasce pausado
//   (3) reativar libera (lead marcado e comentário novo)
//   (4) canal A pausado não afeta B (Instagram x WhatsApp)
//   (5) pausa individual do lead barra sem chave; outros leads seguem
//   (6) reativar lead individual com a chave ligada falha (409) e é auditado
//   (7) lead existente despausado, tocado com a chave ligada, passa a pausado
//   (8) GET do canal: contadores corretos (pausa geral não vira "individual")
//
// Uso: npm run test:bot-pause-switch

import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mock, test } from 'node:test'
import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'
import { createSacTestDatabase } from './sac-test-pglite'

const WA_SECRET = 'segredo-local-bot-pause'
const WA_PHONE_ID = 'meta-local-bot-pause'

type Activity = { companyId: number; agentName: string; action: string; entityType: string; entityId?: string | null; details?: Record<string, unknown> }

async function main() {
  const fixture = await createSacTestDatabase([
    schema.companies, schema.settings, schema.recoveryLeads, schema.whatsappMessages,
    schema.messageJobs, schema.sacAuditEvents, schema.leadTags,
    schema.instagramCommentAutomations, schema.instagramCommentLogs, schema.companyPauseSwitches,
  ])
  const { db, pg } = fixture

  const privateReplies: Array<{ commentId: string; text: string; companyId: number }> = []
  const directMessages: Array<{ recipientId: string; text?: string }> = []
  const aiReplies: number[] = []
  const activities: Activity[] = []
  const company = { id: 1, name: 'Empresa Pausa', slug: 'empresa-pausa' }
  let duringFollowCheck: (() => Promise<void>) | null = null
  let followCheckFollows = true
  const naoResponderCalls: string[] = []

  mock.method(globalThis, 'fetch', async () => { throw new Error('Rede proibida no teste') })
  mock.module('@/lib/db', { namedExports: { db } })
  mock.module('next/server', { namedExports: { NextRequest, NextResponse, after: () => undefined } })
  mock.module('@/lib/nao-responder', { namedExports: { notifyNaoResponder: async (_phone: string, action: string) => { naoResponderCalls.push(action); return { ok: true } } } })
  mock.module('@/lib/leads', { namedExports: { markLeadContacted: async () => undefined } })
  mock.module('@/lib/ai-reply', { namedExports: { generateAndSendAiReply: async (leadId: number) => { aiReplies.push(leadId) } } })
  mock.module('@/lib/instagram', {
    namedExports: {
      sendInstagramPrivateReply: async (p: { commentId: string; text: string; companyId: number }) => { privateReplies.push(p); return { ok: true, messageId: `mid_${privateReplies.length}` } },
      sendInstagramMessage: async (p: { recipientId: string; text?: string }) => { directMessages.push(p); return { ok: true, messageId: `dm_${directMessages.length}` } },
      checkInstagramUserFollowsBusiness: async () => { if (duringFollowCheck) await duringFollowCheck(); return { ok: true, follows: followCheckFollows } },
      replyInstagramCommentPublic: async () => ({ ok: true }),
      hideInstagramComment: async () => ({ ok: true }),
      getInstagramCommentCreatedAt: async () => ({ ok: true, createdAt: new Date() }),
      fetchInstagramUserProfile: async () => ({ ok: false }),
    },
  })
  mock.module('@/lib/agent-auth', {
    namedExports: {
      authenticateAgentRequest: async () => ({ context: { company, agentName: 'Agente Teste', agentId: 'teste' } }),
      logAgentActivity: async (a: Activity) => { activities.push(a) },
    },
  })
  mock.module('@/lib/auth', {
    namedExports: {
      requireCompany: async () => company,
      getCurrentUser: async () => ({ displayName: 'Atendente Teste', primaryEmail: 'atendente@teste.local' }),
    },
  })

  const { processInstagramComment, handleFollowCheckReply } = await import('../src/lib/instagram-comment-processor')
  const tagRoute = await import('../src/app/api/leads/[leadId]/tags/[tag]/route')
  const { captureInstagramInboundInteraction } = await import('../src/lib/instagram-inbound-tags')
  const { ensureLeadPausedBySwitch, isBotBlocked, getBlockingPauseSwitch, pickBlockingSwitch, pauseScopesForChannel } = await import('../src/lib/bot-pause')
  const pauseAll = await import('../src/app/api/v1/companies/[idOrSlug]/pause-all/route')
  const pauseChannel = await import('../src/app/api/v1/companies/[idOrSlug]/pause-channel/route')
  const pauseBot = await import('../src/app/api/v1/companies/[idOrSlug]/conversations/[contact]/pause-bot/route')
  const inboxPause = await import('../src/app/api/inbox/[leadId]/pause/route')
  const whatsappWebhook = await import('../src/app/api/webhooks/whatsapp/route')
  const leadsRoute = await import('../src/app/api/v1/companies/[idOrSlug]/leads/route')
  const { getInheritedPauseFields } = await import('../src/lib/bot-pause')

  const params = { params: Promise.resolve({ idOrSlug: company.slug }) }
  const post = (url: string, body: unknown) => new NextRequest(`http://localhost/${url}`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  })
  const callPauseAll = (action: 'pause' | 'unpause') =>
    pauseAll.POST(post('pause-all', action === 'pause' ? { action, confirm: true, reason: 'teste' } : { action }), params)
  const callPauseChannel = (channel: string, action: 'pause' | 'unpause') =>
    pauseChannel.POST(post('pause-channel', { action, channel, confirm: true }), params)

  let nextComment = 0
  const comment = (commenterId: string) => processInstagramComment({
    companyId: company.id, source: 'instagram_webhook',
    commentId: `c_${++nextComment}`, commenterId, commenterUsername: `user${commenterId}`,
    mediaId: 'media_1', commentText: 'QUERO o link',
  })
  // Replica o que o webhook faz: cria/atualiza o lead e depois processa o comentário.
  const webhookComment = async (commenterId: string) => {
    await captureInstagramInboundInteraction({ companyId: company.id, instagramUserId: commenterId, username: `user${commenterId}`, interaction: 'comment' })
    return comment(commenterId)
  }
  const leadByPhone = async (phone: string) => (await db.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.phone, phone)))[0]
  const logsByStatus = async (status: string) => db.select().from(schema.instagramCommentLogs).where(eq(schema.instagramCommentLogs.status, status))
  const reset = async () => {
    await pg.exec('TRUNCATE recovery_leads, whatsapp_messages, instagram_comment_logs, company_pause_switches, lead_tags, sac_audit_events RESTART IDENTITY')
    privateReplies.length = 0; directMessages.length = 0; aiReplies.length = 0; activities.length = 0
  }

  function whatsappRequest(phone: string, id: string) {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
      metadata: { phone_number_id: WA_PHONE_ID },
      messages: [{ from: phone, id, type: 'text', text: { body: 'Olá, queria saber mais' } }],
    } }] }] })
    return new NextRequest('http://localhost/api/webhooks/whatsapp', {
      method: 'POST', body,
      headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', WA_SECRET).update(body).digest('hex')}` },
    })
  }

  try {
    await db.insert(schema.companies).values(company)
    await db.insert(schema.settings).values({ companyId: company.id, metaPhoneNumberId: WA_PHONE_ID, metaAppSecret: WA_SECRET, instagramUsername: 'conta' })
    await db.insert(schema.instagramCommentAutomations).values({
      companyId: company.id, name: 'Link', keywords: 'QUERO', matchType: 'contains',
      dmMessage: 'Aqui está o link: https://exemplo.com', isActive: true, requireFollowCheck: false,
    })

    await test('funções puras: escopo geral vale para todo canal, canal só para si', () => {
      assert.deepEqual(pauseScopesForChannel('instagram'), ['all', 'instagram'])
      assert.deepEqual(pauseScopesForChannel('whatsapp'), ['all', 'whatsapp'])
      assert.deepEqual(pauseScopesForChannel(null), ['all', 'whatsapp'])
      assert.deepEqual(pauseScopesForChannel('mineracao'), ['all'])
      const sw = (scope: 'all' | 'whatsapp' | 'instagram' | 'email', active: boolean) => ({ scope, active, pausedAt: null, pausedBy: null, reason: null })
      assert.equal(pickBlockingSwitch([sw('whatsapp', true)], 'instagram'), null)
      assert.equal(pickBlockingSwitch([sw('instagram', true)], 'whatsapp'), null)
      assert.equal(pickBlockingSwitch([sw('all', true)], 'email')?.scope, 'all')
      assert.equal(pickBlockingSwitch([sw('all', false), sw('instagram', true)], 'instagram')?.scope, 'instagram')
    })

    await test('(1)(2) pausa geral ativa: lead novo nasce pausado e o comentário NÃO envia, com log ignorado_pausa', async () => {
      await reset()
      const res = await callPauseAll('pause')
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.equal(json.switchActive, true)
      assert.equal(json.affected, 0, 'não havia nenhum lead: o caso é só o futuro')

      const result = await webhookComment('1001')
      assert.equal(result.status, 'ignored')
      assert.equal(result.reason, 'ignorado_pausa')
      assert.equal(privateReplies.length, 0, 'nenhuma Private Reply pode sair com a empresa pausada')
      assert.equal(directMessages.length, 0)

      const lead = await leadByPhone('ig_1001')
      assert.ok(lead, 'o lead do comentário é criado (a conversa existe na inbox)')
      assert.equal(lead.botPaused, true, 'lead novo herda a pausa')
      assert.equal(lead.botPausedAll, true, 'marcado como pausa geral: "Reativar tudo" reverte')
      assert.equal(lead.botPausedBy, 'auto (pausa geral ativa)')

      const logs = await logsByStatus('ignorado_pausa')
      assert.equal(logs.length, 1)
      assert.ok(logs[0].automationId, 'o log guarda qual regra foi ignorada')
      assert.equal(await db.select().from(schema.whatsappMessages).then(r => r.length), 0, 'nada gravado como mensagem do bot')
    })

    await test('(1) o mesmo comentário reentregue pela Meta continua ignorado (idempotente)', async () => {
      const again = await processInstagramComment({
        companyId: company.id, source: 'instagram_webhook', commentId: 'c_1', commenterId: '1001',
        mediaId: 'media_1', commentText: 'QUERO o link',
      })
      assert.equal(again.status, 'skipped')
      assert.equal(privateReplies.length, 0)
    })

    await test('(3) reativar libera: lead marcado volta e comentário novo envia', async () => {
      const res = await callPauseAll('unpause')
      const json = await res.json()
      assert.equal(json.switchActive, false)
      assert.equal(json.affected, 1)
      const lead = await leadByPhone('ig_1001')
      assert.equal(lead.botPaused, false)
      assert.equal(lead.botPausedAll, false)
      assert.equal((await getBlockingPauseSwitch(company.id, 'instagram')), null)

      const result = await webhookComment('1002')
      assert.equal(result.status, 'sent')
      assert.equal(privateReplies.length, 1)
      const newLead = await leadByPhone('ig_1002')
      assert.equal(newLead.botPaused, false, 'com a chave desligada, lead novo nasce com o bot ativo')
    })

    await test('(4) canal A pausado não afeta B: Instagram pausado não pausa WhatsApp e vice-versa', async () => {
      await reset()
      assert.equal((await callPauseChannel('instagram', 'pause')).status, 200)

      assert.equal((await webhookComment('2001')).status, 'ignored', 'Instagram pausado barra o comentário')
      assert.equal(privateReplies.length, 0)

      const wa = await whatsappWebhook.POST(whatsappRequest('5511999990100', 'wamid.pausa.1'))
      assert.equal(wa.status, 200)
      const waLead = await leadByPhone('5511999990100')
      assert.equal(waLead.channel, 'whatsapp')
      assert.equal(waLead.botPaused, false, 'WhatsApp não foi pausado: lead nasce ativo')
      assert.equal((await isBotBlocked({ companyId: company.id, channel: 'whatsapp', leadBotPaused: false })).blocked, false)
      assert.equal((await isBotBlocked({ companyId: company.id, channel: 'instagram', leadBotPaused: false })).blocked, true)

      // agora o inverso: reativa Instagram e pausa só o WhatsApp
      assert.equal((await callPauseChannel('instagram', 'unpause')).status, 200)
      assert.equal((await callPauseChannel('whatsapp', 'pause')).status, 200)
      assert.equal((await webhookComment('2002')).status, 'sent', 'Instagram liberado enquanto o WhatsApp está pausado')
      const waNew = await whatsappWebhook.POST(whatsappRequest('5511999990200', 'wamid.pausa.2'))
      assert.equal(waNew.status, 200)
      const waNewLead = await leadByPhone('5511999990200')
      assert.equal(waNewLead.botPaused, true, 'lead novo do WhatsApp nasce pausado com a chave do WhatsApp ligada')
      assert.equal(waNewLead.botPausedChannel, 'whatsapp')
      assert.equal(waNewLead.botPausedAll, false)
      assert.equal(aiReplies.length, 0, 'IA nunca acionada para lead pausado (WhatsApp)')
    })

    await test('(5) pausa individual do lead barra o comentário sem nenhuma chave; outro lead segue', async () => {
      await reset()
      await captureInstagramInboundInteraction({ companyId: company.id, instagramUserId: '3001', username: 'u3001', interaction: 'comment' })
      await db.update(schema.recoveryLeads).set({ botPaused: true, botPausedBy: 'Atendente Teste' }).where(eq(schema.recoveryLeads.phone, 'ig_3001'))

      assert.equal((await comment('3001')).status, 'ignored')
      assert.equal(privateReplies.length, 0)
      const [log] = await logsByStatus('ignorado_pausa')
      assert.match(log.errorMessage ?? '', /este lead/)

      assert.equal((await webhookComment('3002')).status, 'sent')
      assert.equal(privateReplies.length, 1)
    })

    await test('(6) reativar lead individual com a chave ligada falha com 409 (API e inbox); pausa/despausa individual é auditada com autor', async () => {
      await reset()
      assert.equal((await callPauseAll('pause')).status, 200)
      await db.insert(schema.recoveryLeads).values({
        companyId: company.id, phone: '5511999990300', name: 'Contato', channel: 'whatsapp', platform: 'sac',
        eventType: 'atendimento', status: 'in_conversation', botPaused: true, botPausedAll: true,
      })
      const lead = await leadByPhone('5511999990300')
      const pbParams = { params: Promise.resolve({ idOrSlug: company.slug, contact: `lead:${lead.id}` }) }

      const blockedApi = await pauseBot.POST(post('pause-bot', { pause: false }), pbParams)
      assert.equal(blockedApi.status, 409)
      assert.equal((await blockedApi.json()).switchScope, 'all')
      const ibParams = { params: Promise.resolve({ leadId: String(lead.id) }) }
      const blockedInbox = await inboxPause.POST(post('pause', { paused: false }), ibParams)
      assert.equal(blockedInbox.status, 409)
      assert.equal((await leadByPhone('5511999990300')).botPaused, true, 'continua pausado')

      assert.equal((await callPauseAll('unpause')).status, 200)
      activities.length = 0

      const resumedInbox = await inboxPause.POST(post('pause', { paused: true }), ibParams)
      assert.equal(resumedInbox.status, 200)
      const releasedInbox = await inboxPause.POST(post('pause', { paused: false }), ibParams)
      assert.equal(releasedInbox.status, 200)
      const pausedApi = await pauseBot.POST(post('pause-bot', { pause: true, reason: 'cliente na linha' }), pbParams)
      assert.equal(pausedApi.status, 200)

      const inboxLogs = activities.filter(a => a.details?.source === 'inbox')
      assert.deepEqual(inboxLogs.map(a => a.action), ['pause_bot', 'resume_bot'])
      assert.ok(inboxLogs.every(a => a.agentName === 'Atendente Teste' && a.details?.actionBy === 'Atendente Teste'), 'autor humano gravado')
      const apiLog = activities.find(a => a.details?.source === 'api')
      assert.equal(apiLog?.action, 'pause_bot')
      assert.equal(apiLog?.agentName, 'Agente Teste')
      assert.equal(apiLog?.details?.actionBy, 'Agente Teste (Agente IA)')
    })

    await test('chave e pausa em massa são auditadas com autor, escopo e estado da chave', async () => {
      await reset()
      await callPauseAll('pause')
      await callPauseChannel('instagram', 'pause')
      await callPauseChannel('instagram', 'unpause')
      await callPauseAll('unpause')
      assert.deepEqual(activities.map(a => a.action), ['pause_all', 'pause_channel', 'unpause_channel', 'unpause_all'])
      assert.ok(activities.every(a => a.details?.actionBy === 'Agente Teste (Agente IA)'))
      assert.deepEqual(activities.map(a => a.details?.switchActive), [true, true, false, false])
    })

    await test('(7) lead existente despausado, tocado com a chave ligada, passa a pausado; pausa individual não é sobrescrita', async () => {
      await reset()
      await db.insert(schema.recoveryLeads).values([
        { companyId: company.id, phone: 'ig_4001', platform: 'instagram', channel: 'instagram', eventType: 'x', status: 'in_conversation', botPaused: false },
        { companyId: company.id, phone: 'ig_4002', platform: 'instagram', channel: 'instagram', eventType: 'x', status: 'in_conversation', botPaused: true, botPausedBy: 'Atendente Teste' },
      ])
      await callPauseChannel('instagram', 'pause')
      // pause-channel só marca o que já existia: simula um lead criado por um caminho que não herdou
      await db.update(schema.recoveryLeads).set({ botPaused: false, botPausedChannel: null, botPausedAt: null, botPausedBy: null }).where(eq(schema.recoveryLeads.phone, 'ig_4001'))

      const open = await leadByPhone('ig_4001')
      const touched = await ensureLeadPausedBySwitch(open)
      assert.equal(touched.botPaused, true)
      assert.equal((await leadByPhone('ig_4001')).botPausedChannel, 'instagram')

      const manual = await leadByPhone('ig_4002')
      const untouched = await ensureLeadPausedBySwitch(manual)
      assert.equal(untouched.botPausedBy, 'Atendente Teste', 'pausa manual preservada')
      assert.equal((await leadByPhone('ig_4002')).botPausedChannel, null)

      // chave de OUTRO canal não pausa lead do Instagram
      await db.update(schema.recoveryLeads).set({ botPaused: false }).where(eq(schema.recoveryLeads.phone, 'ig_4001'))
      await callPauseChannel('instagram', 'unpause')
      await callPauseChannel('whatsapp', 'pause')
      const igLead = await leadByPhone('ig_4001')
      assert.equal((await ensureLeadPausedBySwitch(igLead)).botPaused, false)
    })

    await test('(8) GET do canal: pausa geral não vira "individual"; chave aparece por canal', async () => {
      await reset()
      await db.insert(schema.recoveryLeads).values([
        { companyId: company.id, phone: 'ig_5001', platform: 'instagram', channel: 'instagram', eventType: 'x', status: 'in_conversation', botPaused: false },
        { companyId: company.id, phone: 'ig_5002', platform: 'instagram', channel: 'instagram', eventType: 'x', status: 'in_conversation', botPaused: true, botPausedBy: 'Atendente Teste' },
      ])
      await callPauseAll('pause') // pausa ig_5001 em massa (geral); ig_5002 já era manual
      const res = await pauseChannel.GET(new NextRequest('http://localhost/pause-channel'), params)
      const json = await res.json()
      assert.equal(json.allSwitchActive, true)
      const ig = json.channels.instagram
      assert.equal(ig.paused, 2)
      assert.equal(ig.pausedByGeneral, 1)
      assert.equal(ig.pausedByChannel, 0)
      assert.equal(ig.pausedIndividually, 1, 'só a pausa do atendente é "manual"')
      assert.equal(ig.switchActive, false, 'a chave do canal é independente da geral')
      assert.equal(json.channels.whatsapp.switchActive, false)

      const generalRes = await pauseAll.GET(new NextRequest('http://localhost/pause-all'), params)
      assert.equal((await generalRes.json()).switchActive, true)
    })

    await test('(2) herança NO INSERT (sem depender do UPDATE posterior): API de leads e helper', async () => {
      await reset()
      assert.deepEqual(await getInheritedPauseFields(company.id, 'whatsapp'), {}, 'sem chave: nada a herdar')
      await callPauseChannel('whatsapp', 'pause')
      const fields = await getInheritedPauseFields(company.id, 'whatsapp')
      assert.equal(fields.botPaused, true)
      assert.equal(fields.botPausedChannel, 'whatsapp')
      assert.deepEqual(await getInheritedPauseFields(company.id, 'instagram'), {}, 'outro canal não herda')

      const res = await leadsRoute.POST(post('leads', { phone: '5511999990400', name: 'Novo' }), params)
      assert.equal(res.status, 201)
      const created = await leadByPhone('5511999990400')
      assert.equal(created.botPaused, true, 'lead criado pela API nasce pausado com a chave do canal ligada')
      assert.equal(created.botPausedChannel, 'whatsapp')

      const igRes = await leadsRoute.POST(post('leads', { phone: '5511999990401', name: 'Insta', channel: 'instagram' }), params)
      assert.equal(igRes.status, 201)
      assert.equal((await leadByPhone('5511999990401')).botPaused, false, 'lead do canal não pausado nasce ativo')
    })

    await test('(1) pausa ligada ENQUANTO o follow check consulta a Graph API: a segunda leitura barra o envio', async () => {
      await reset()
      await db.update(schema.instagramCommentAutomations).set({ requireFollowCheck: true })
      duringFollowCheck = async () => { await callPauseAll('pause') }
      try {
        const result = await webhookComment('6001')
        assert.equal(result.status, 'ignored')
        assert.equal(privateReplies.length, 0, 'a pausa ligada no meio do processamento vale antes do envio')
        const logs = await logsByStatus('ignorado_pausa')
        assert.equal(logs.length, 1)
        assert.match(logs[0].errorMessage ?? '', /antes do envio/)
      } finally {
        duringFollowCheck = null
        await db.update(schema.instagramCommentAutomations).set({ requireFollowCheck: false })
      }
    })

    await test('(1b) gate de seguidor, LIBERAÇÃO: pausa ligada enquanto a Graph API responde NÃO envia o conteúdo e devolve o gate; depois de reativar, libera', async () => {
      await reset()
      const [auto] = await db.insert(schema.instagramCommentAutomations).values({
        companyId: company.id, name: 'Gate', keywords: 'GATE', matchType: 'contains',
        dmMessage: 'Conteúdo do gate', isActive: true, requireFollowCheck: true,
      }).returning()
      const [lead] = await db.insert(schema.recoveryLeads).values({
        companyId: company.id, phone: 'ig_8001', name: 'Gate', channel: 'instagram', platform: 'instagram', eventType: 'x',
        status: 'in_conversation', botPaused: false, pendingFollowCheckAutomationId: auto.id, pendingFollowCheckAttempts: 0,
      }).returning()
      const args = { companyId: company.id, leadId: lead.id, igsid: '8001', automationId: auto.id }
      followCheckFollows = true
      duringFollowCheck = async () => { await callPauseChannel('instagram', 'pause') }
      try {
        const res = await handleFollowCheckReply(args)
        assert.equal(res.status, 'ignorado_pausa')
        assert.equal(directMessages.length, 0, 'nada pode sair com a pausa ligada no meio')
        assert.equal(await db.select().from(schema.whatsappMessages).then(r => r.length), 0, 'nada gravado como enviado')
        const after = await db.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.id, lead.id)).then(r => r[0])
        assert.equal(after.pendingFollowCheckAutomationId, auto.id, 'o gate volta pendente pra não perder a promessa ao lead')
      } finally { duringFollowCheck = null }

      await callPauseChannel('instagram', 'unpause')
      const res2 = await handleFollowCheckReply(args)
      assert.equal(res2.status, 'released')
      assert.equal(directMessages.length, 1)
      assert.equal(directMessages[0].text, 'Conteúdo do gate')
      await db.delete(schema.instagramCommentAutomations).where(eq(schema.instagramCommentAutomations.id, auto.id))
    })

    await test('(1c) gate de seguidor, REFORÇO (não segue): pausa ligada durante a Graph API NÃO envia e não gasta tentativa', async () => {
      await reset()
      const [auto] = await db.insert(schema.instagramCommentAutomations).values({
        companyId: company.id, name: 'Gate2', keywords: 'GATE2', matchType: 'contains',
        dmMessage: 'Conteúdo do gate 2', isActive: true, requireFollowCheck: true,
      }).returning()
      const [lead] = await db.insert(schema.recoveryLeads).values({
        companyId: company.id, phone: 'ig_8002', name: 'Gate2', channel: 'instagram', platform: 'instagram', eventType: 'x',
        status: 'in_conversation', botPaused: false, pendingFollowCheckAutomationId: auto.id, pendingFollowCheckAttempts: 0,
      }).returning()
      const args = { companyId: company.id, leadId: lead.id, igsid: '8002', automationId: auto.id }
      followCheckFollows = false
      duringFollowCheck = async () => { await callPauseAll('pause') }
      try {
        const res = await handleFollowCheckReply(args)
        assert.equal(res.status, 'ignorado_pausa')
        assert.equal(directMessages.length, 0)
        assert.equal(await db.select().from(schema.whatsappMessages).then(r => r.length), 0)
        const after = await db.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.id, lead.id)).then(r => r[0])
        assert.equal(after.pendingFollowCheckAttempts, 0, 'a tentativa contada é desfeita')
        assert.equal(after.pendingFollowCheckAutomationId, auto.id)
      } finally { duringFollowCheck = null; followCheckFollows = true }

      // Sem pausa e sem corrida o reforço continua saindo normalmente (não regrediu).
      await callPauseAll('unpause')
      followCheckFollows = false
      const res2 = await handleFollowCheckReply(args)
      followCheckFollows = true
      assert.equal(res2.status, 'still_pending')
      assert.equal(directMessages.length, 1)
      await db.delete(schema.instagramCommentAutomations).where(eq(schema.instagramCommentAutomations.id, auto.id))
    })

    await test('(2b) remover a tag "pessoa" com a chave da empresa/canal ligada mantém o lead pausado; sem chave, despausa como antes', async () => {
      await reset()
      naoResponderCalls.length = 0
      const mkLead = async (phone: string, channel: string) => {
        const now = new Date()
        const [l] = await db.insert(schema.recoveryLeads).values({
          companyId: company.id, phone, name: 'Pessoa', channel, platform: channel, eventType: 'x', status: 'in_conversation',
          botPaused: true, botPausedBy: 'tag:pessoa', botPausedAt: now,
        }).returning()
        await db.insert(schema.leadTags).values({ leadId: l.id, tag: 'pessoa', createdBy: 'teste' })
        return l
      }
      const del = (leadId: number) => tagRoute.DELETE(
        new NextRequest(`http://localhost/api/leads/${leadId}/tags/pessoa`, { method: 'DELETE' }),
        { params: Promise.resolve({ leadId: String(leadId), tag: 'pessoa' }) },
      )

      // Chave do canal instagram ligada: lead do instagram segue pausado e passa a pertencer à chave.
      await callPauseChannel('instagram', 'pause')
      const igLead = await mkLead('ig_9001', 'instagram')
      const res = await del(igLead.id)
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.equal(json.botPaused, true)
      assert.equal(json.pauseSwitchActive, true)
      assert.equal(json.switchScope, 'instagram')
      assert.match(json.warning, /pausa da empresa segue ativa/)
      assert.equal(naoResponderCalls.length, 0, 'a Nina não é avisada pra voltar a responder')
      const kept = await db.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.id, igLead.id)).then(r => r[0])
      assert.equal(kept.botPaused, true)
      assert.equal(kept.botPausedChannel, 'instagram', 'dono da pausa agora é a chave: reativar o canal solta o lead')
      assert.equal(await db.select().from(schema.leadTags).where(eq(schema.leadTags.leadId, igLead.id)).then(r => r.length), 0, 'a tag foi removida mesmo assim')

      // Canal WhatsApp NÃO está pausado: o lead de whatsapp despausa normalmente.
      const waLead = await mkLead('5511999990901', 'whatsapp')
      const res2 = await del(waLead.id)
      const json2 = await res2.json()
      assert.equal(json2.botPaused, false)
      assert.equal(json2.pauseSwitchActive, undefined)
      assert.deepEqual(naoResponderCalls, ['desmarcar'])

      // Reativar o canal solta o lead que a chave segurou.
      await callPauseChannel('instagram', 'unpause')
      const released = await db.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.id, igLead.id)).then(r => r[0])
      assert.equal(released.botPaused, false)
    })

    await test('chave de empresa A não vaza para empresa B', async () => {
      await reset()
      await db.insert(schema.companies).values({ id: 2, name: 'Outra', slug: 'outra' })
      await callPauseAll('pause')
      assert.equal((await isBotBlocked({ companyId: 1, channel: 'instagram', leadBotPaused: false })).blocked, true)
      assert.equal((await isBotBlocked({ companyId: 2, channel: 'instagram', leadBotPaused: false })).blocked, false)
      const rows = await db.select().from(schema.companyPauseSwitches).where(and(eq(schema.companyPauseSwitches.companyId, 2)))
      assert.equal(rows.length, 0)
    })

    await test('regra por post vence a global da mesma palavra de forma determinística', async () => {
      await reset()
      await db.update(schema.instagramCommentAutomations).set({ isActive: false })
        .where(eq(schema.instagramCommentAutomations.companyId, company.id))
      await db.insert(schema.instagramCommentAutomations).values([
        { companyId: company.id, name: 'Global prioridade', keywords: 'PRIORIDADE', dmMessage: 'Global', isActive: true },
        { companyId: company.id, name: 'Post prioridade', mediaId: 'media_1', keywords: 'PRIORIDADE', dmMessage: 'Post', isActive: true },
      ])
      const result = await processInstagramComment({
        companyId: company.id, source: 'instagram_webhook', commentId: 'prioridade-por-post',
        commenterId: 'prioridade-por-post', mediaId: 'media_1', commentText: 'PRIORIDADE',
      })
      assert.equal(result.status, 'sent')
      assert.equal(privateReplies.length, 1)
      assert.equal(privateReplies[0]?.text, 'Post')
    })

    await test('Luana sem template 021126 usa a regra global comum e não registra bloqueio', async () => {
      await reset()
      await db.delete(schema.instagramCommentAutomations).where(eq(schema.instagramCommentAutomations.companyId, company.id))
      await db.insert(schema.instagramCommentAutomations).values({
        companyId: company.id, name: 'Luana global', keywords: 'Luana', matchType: 'contains',
        dmMessage: 'DM comum da Luana', isActive: true,
      })

      const result = await processInstagramComment({
        companyId: company.id, source: 'instagram_webhook', commentId: 'luana-sem-template',
        commenterId: 'luana-sem-template', mediaId: 'media_1', commentText: 'Quero a Luana',
      })
      assert.equal(result.status, 'sent')
      assert.equal(privateReplies.length, 1)
      assert.equal(privateReplies[0]?.text, 'DM comum da Luana')
      assert.equal((await db.select().from(schema.sacAuditEvents)).length, 0)
    })

    await test('Luana sem template 021126 e sem regra comum retorna no_keyword_matched', async () => {
      await reset()
      await db.delete(schema.instagramCommentAutomations).where(eq(schema.instagramCommentAutomations.companyId, company.id))
      await db.insert(schema.instagramCommentAutomations).values({
        companyId: company.id, name: 'Outra palavra', keywords: 'PREÇO', matchType: 'contains',
        dmMessage: 'Sem relação', isActive: true,
      })

      const result = await processInstagramComment({
        companyId: company.id, source: 'instagram_webhook', commentId: 'luana-sem-regra',
        commenterId: 'luana-sem-regra', mediaId: 'media_1', commentText: 'Luana',
      })
      assert.deepEqual(result, { status: 'skipped', reason: 'no_keyword_matched' })
      assert.equal(privateReplies.length, 0)
      assert.equal((await db.select().from(schema.sacAuditEvents)).length, 0)
    })

    await test('Luana com template 021126 válido reserva o gatilho e ignora a regra comum', async () => {
      await reset()
      await db.delete(schema.instagramCommentAutomations).where(eq(schema.instagramCommentAutomations.companyId, company.id))
      await db.insert(schema.instagramCommentAutomations).values({
        companyId: company.id, name: 'Luana comum', keywords: 'Luana', matchType: 'contains',
        dmMessage: 'DM comum que não pode sair', isActive: true,
      })
      await db.insert(schema.instagramCommentAutomations).values({
        companyId: company.id, name: '021126', mediaId: 'media_1', keywords: 'Luana', matchType: 'contains',
        dmMessage: 'Oi! Aqui está a página de avaliação sobre pedidos de clientes.\n\nEla mostra o que o vídeo explica, o que a empresa precisa ter pronto e traz 7 perguntas para você ver se essa rotina cabe no seu caso.\n\nO assistente organiza o pedido e a sua equipe revisa antes de qualquer envio ao cliente. Se quiser conversar sobre a sua operação, é só responder por aqui.\n\nhttps://www.casaldotrafego.com/blog/avaliar-assistente-ia-pedidos-de-clientes',
        isActive: true, templateId: '021126',
        templateVariables: { url: 'https://www.casaldotrafego.com/blog/avaliar-assistente-ia-pedidos-de-clientes' },
        consentRequired: true, metaWindowHours: 168, apiOrigin: 'instagram_graph', publicReply: null,
        hideCommentAfterReply: false,
      })

      const result = await processInstagramComment({
        companyId: company.id, source: 'instagram_webhook', commentId: 'luana-template-valido',
        commenterId: 'luana-template-valido', mediaId: 'media_1', commentText: 'Luana', commentCreatedAt: new Date(),
      })
      assert.equal(result.status, 'sent')
      assert.equal(privateReplies.length, 1)
      assert.match(privateReplies[0]?.text ?? '', /página de avaliação/)
      assert.notEqual(privateReplies[0]?.text, 'DM comum que não pode sair')
    })

    await test('Luana com template 021126 adulterado continua bloqueada', async () => {
      await reset()
      await db.delete(schema.instagramCommentAutomations).where(eq(schema.instagramCommentAutomations.companyId, company.id))
      await db.insert(schema.instagramCommentAutomations).values({
        companyId: company.id, name: '021126 inválido', mediaId: 'media_1', keywords: 'Luana', matchType: 'contains',
        dmMessage: 'Texto adulterado', isActive: true, templateId: '021126', consentRequired: false,
        metaWindowHours: 168, apiOrigin: 'instagram_graph', publicReply: null, hideCommentAfterReply: false,
      })

      const result = await processInstagramComment({
        companyId: company.id, source: 'instagram_webhook', commentId: 'luana-template-invalido',
        commenterId: 'luana-template-invalido', mediaId: 'media_1', commentText: 'Luana', commentCreatedAt: new Date(),
      })
      assert.deepEqual(result, { status: 'blocked', reason: 'template_registration_or_consent_invalid' })
      assert.equal(privateReplies.length, 0)
    })

    await test('Luana sem template 021126 preserva o gate de seguidor da regra comum', async () => {
      await reset()
      await db.delete(schema.instagramCommentAutomations).where(eq(schema.instagramCommentAutomations.companyId, company.id))
      const [automation] = await db.insert(schema.instagramCommentAutomations).values({
        companyId: company.id, name: 'Luana exige seguir', keywords: 'Luana', matchType: 'contains',
        dmMessage: 'Conteúdo que só sai para seguidor', isActive: true, requireFollowCheck: true,
      }).returning()
      followCheckFollows = false
      try {
        const result = await processInstagramComment({
          companyId: company.id, source: 'instagram_webhook', commentId: 'luana-gate-seguidor',
          commenterId: 'luana-gate-seguidor', mediaId: 'media_1', commentText: 'Luana',
        })
        assert.equal(result.status, 'sent')
        assert.equal(privateReplies.length, 1)
        assert.match(privateReplies[0]?.text ?? '', /Segue lá/)
        assert.notEqual(privateReplies[0]?.text, 'Conteúdo que só sai para seguidor')
        assert.equal((await leadByPhone('ig_luana-gate-seguidor')).pendingFollowCheckAutomationId, automation.id)
      } finally {
        followCheckFollows = true
      }
    })

  } finally {
    await fixture.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
