// Mudança de regra ordenada pelo Gastão em 16/11/2026.
// Postgres 16 real (QA_PG_URL), processador e transporte reais, fetch Graph interceptada.
import assert from 'node:assert/strict'
import { test, mock, before, beforeEach, afterEach, after } from 'node:test'
import { randomInt } from 'node:crypto'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, inArray } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'

const url = process.env.QA_PG_URL
if (!url) throw new Error('QA_PG_URL é obrigatório: use Postgres descartável com schema aplicado.')
const client = postgres(url, { max: 5, onnotice: () => {} })
const db = drizzle(client, { schema })
const graph: Array<{ url: string; body: { recipient?: { comment_id?: string }; message?: { text: string }; hide?: boolean } }> = []
const queries: string[] = []
const observedDb = drizzle(client, { schema, logger: { logQuery(query) { queries.push(query) } } })
mock.module('@/lib/db', { namedExports: { db: observedDb } })
mock.module('@/lib/ai-reply', { namedExports: { generateAndSendAiReply: async () => { throw new Error('IA proibida nesta automação') } } })
let duringFollowCheck: (() => Promise<void>) | undefined
let duringMediaRead: (() => Promise<void>) | undefined
const sideEffects: Promise<unknown>[] = []
const drainSideEffects = async () => {
  const results = await Promise.allSettled(sideEffects.splice(0))
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason
  }
}
mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const address = String(input)
  assert.ok(address.startsWith('https://graph.instagram.com/'), 'rede real proibida')
  if (address.includes('?fields=id,username,media_type')) await duringMediaRead?.()
  const body = init?.body ? JSON.parse(String(init.body)) : {}
  graph.push({ url: address, body })
  if (address.includes('is_user_follow_business')) {
    await duringFollowCheck?.()
    return Response.json({ is_user_follow_business: true })
  }
  return Response.json({ id: '123', message_id: `msg_${graph.length}` })
})
let processComment: typeof import('../src/lib/instagram-comment-processor').processInstagramComment
let setPauseSwitch: typeof import('../src/lib/bot-pause').setPauseSwitch
// IDs negativos não disputam a sequência serial das outras suítes.
const commonId = -randomInt(1, 1_000_000_000)
const isabelaId = commonId - 1
const companies = [{ id: commonId, name: 'Comum', slug: 'empresa-comum' }, { id: isabelaId, name: 'Isabela', slug: 'isabela-fanini' }]
const ownedCompanyIds: number[] = []
const cleanup = async () => {
  // As FKs removem apenas os dados vinculados às empresas criadas neste caso.
  if (ownedCompanyIds.length) {
    await db.delete(schema.companies).where(inArray(schema.companies.id, ownedCompanyIds))
    ownedCompanyIds.length = 0
  }
}
const dmCalls = () => graph.filter(call => call.url.endsWith('/messages'))
const comment = async (companyId = commonId, extra: Partial<Parameters<typeof processComment>[0]> = {}) => {
  try {
    return await processComment({
      companyId, commentId: 'c1', commenterId: 'person', mediaId: '12345', commentText: 'quero',
      source: 'instagram_webhook', commentCreatedAt: new Date(), ...extra,
    })
  } finally {
    // O processador não aguarda reply/hide. O teste precisa aguardar as
    // promessas reais antes de conferir contadores ou limpar a próxima fixture.
    await drainSideEffects()
  }
}
const pausedLead = async (companyId: number, reason = 'Atendente humana', botPaused = true) => {
  const [lead] = await db.insert(schema.recoveryLeads).values({ companyId, phone: 'ig_person', name: 'Teste',
    platform: 'instagram', channel: 'instagram', eventType: 'instagram_direct', botPaused, botPausedBy: reason,
  }).returning()
  await db.insert(schema.leadTags).values({ leadId: lead.id, tag: 'pessoa', scopeChannel: 'instagram' })
  return lead
}
before(async () => {
  const instagram = await import('../src/lib/instagram')
  const observe = <T extends unknown[], R>(fn: (...args: T) => Promise<R>) => (...args: T) => {
    const task = fn(...args)
    sideEffects.push(task)
    return task
  }
  // Espiona só o término; configurações, validações e transporte continuam reais.
  mock.module('@/lib/instagram', { namedExports: {
    ...instagram,
    replyInstagramCommentPublic: observe(instagram.replyInstagramCommentPublic),
    hideInstagramComment: observe(instagram.hideInstagramComment),
  } })
  ;({ processInstagramComment: processComment } = await import('../src/lib/instagram-comment-processor'))
  ;({ setPauseSwitch } = await import('../src/lib/bot-pause'))
})
beforeEach(async () => {
  const created = await db.insert(schema.companies).values(companies).returning({ id: schema.companies.id })
  ownedCompanyIds.push(...created.map(company => company.id))
  for (const company of companies) {
    await db.insert(schema.settings).values({ companyId: company.id, instagramAccountId: `account_${company.id}`, instagramAccessToken: 'fake-test-only' })
    await db.insert(schema.instagramCommentAutomations).values({ companyId: company.id, name: 'Regra', keywords: 'quero',
      dmMessage: `Conteúdo ${company.id}`, publicReply: 'Enviei no Direct', hideCommentAfterReply: true, isActive: true })
  }
  graph.length = 0
  queries.length = 0
  duringFollowCheck = undefined
  duringMediaRead = undefined
})
afterEach(async () => {
  try { await drainSideEffects() } finally { await cleanup() }
})
after(async () => {
  try { await cleanup() } finally { await client.end({ timeout: 2 }) }
})

for (const company of companies) {
  for (const scope of ['all', 'instagram'] as const) {
    test(`${company.slug}: pausa ${scope} + lead humano pausado + pessoa envia exatamente 1 DM`, async () => {
      const lead = await pausedLead(company.id)
      await setPauseSwitch({ companyId: company.id, scope, active: true, by: 'Teste' })
      assert.equal((await comment(company.id)).status, 'sent')
      assert.equal(dmCalls().length, 1)
      assert.equal(dmCalls()[0].url, `https://graph.instagram.com/v21.0/account_${company.id}/messages`)
      assert.deepEqual(dmCalls()[0].body, { recipient: { comment_id: 'c1' }, message: { text: `Conteúdo ${company.id}` } })
      const [log] = await db.select().from(schema.instagramCommentLogs).where(inArray(schema.instagramCommentLogs.companyId, ownedCompanyIds))
      assert.equal(log.status, 'sent')
      assert.equal(log.companyId, company.id)
      assert.equal(graph.filter(call => call.url.endsWith('/replies')).length, 1)
      assert.equal(graph.filter(call => call.body.hide === true).length, 1)
      assert.equal((await db.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.id, lead.id)))[0].botPaused, true)
      assert.equal((await db.select().from(schema.companyPauseSwitches).where(eq(schema.companyPauseSwitches.companyId, company.id)))[0].active, true)
      assert.equal((await comment(company.id)).reason, 'comment_already_processed')
      assert.equal((await comment(company.id, { commentId: 'c2' })).reason, 'already_sent_for_this_media')
      assert.equal(dmCalls().length, 1, 'reentrega e novo comentário no mesmo post não duplicam')
    })
  }
  test(`${company.slug}: opt-out/anti-loop continuam bloqueando mesmo se botPaused=false`, async () => {
    for (const [reason, expected] of [['optout_whatsapp', 'optout'], ['revisao_possivel_optout', 'optout'], ['opt-out', 'optout'], ['Anti-loop detectado', 'anti_loop']]) {
      await db.delete(schema.recoveryLeads).where(eq(schema.recoveryLeads.companyId, company.id))
      await pausedLead(company.id, reason, false)
      assert.deepEqual(await comment(company.id), { status: 'blocked', reason: expected })
    }
    assert.equal(graph.length, 0)
  })
  test(`${company.slug}: conta não responde ao próprio comentário/eco`, async () => {
    assert.deepEqual(await comment(company.id, { commenterId: `account_${company.id}` }), { status: 'blocked', reason: 'anti_loop' })
    assert.equal(graph.length, 0)
  })
}

test('regra inativa, post diferente, palavra diferente e janela de horário continuam bloqueando', async () => {
  await db.update(schema.instagramCommentAutomations).set({ isActive: false }).where(eq(schema.instagramCommentAutomations.companyId, commonId))
  assert.equal((await comment()).reason, 'no_active_automations')
  await db.update(schema.instagramCommentAutomations).set({ isActive: true, mediaId: 'outro-post' }).where(eq(schema.instagramCommentAutomations.companyId, commonId))
  assert.equal((await comment()).reason, 'no_matching_post_rule')
  await db.update(schema.instagramCommentAutomations).set({ mediaId: null }).where(eq(schema.instagramCommentAutomations.companyId, commonId))
  assert.equal((await comment(commonId, { commentText: 'outra palavra' })).reason, 'no_keyword_matched')
  // 25:00 não é atingível no relógio; janela permanece sempre fechada.
  await db.update(schema.instagramCommentAutomations).set({ activeHoursStart: '25:00', activeHoursEnd: '25:01' }).where(eq(schema.instagramCommentAutomations.companyId, commonId))
  assert.equal((await comment()).reason, 'no_keyword_matched')
  assert.equal(graph.length, 0)
})

test('isolamento: regra, opt-out e dedupe da outra empresa não vazam', async () => {
  await pausedLead(isabelaId, 'optout_whatsapp')
  assert.equal((await comment(commonId)).status, 'sent')
  assert.equal((await comment(isabelaId)).reason, 'optout')
  await db.update(schema.recoveryLeads).set({ botPausedBy: 'Atendente' }).where(eq(schema.recoveryLeads.companyId, isabelaId))
  assert.equal((await comment(isabelaId)).status, 'sent', 'mesmo commentId em outro tenant tem claim próprio')
  assert.deepEqual(dmCalls().map(call => call.body.message?.text), [`Conteúdo ${commonId}`, `Conteúdo ${isabelaId}`])
})

test('três reentregas concorrentes reservam e enviam uma única DM', async () => {
  const results = await Promise.all([comment(), comment(), comment()])
  assert.equal(results.filter(result => result.status === 'sent').length, 1)
  assert.equal(dmCalls().length, 1)
  assert.equal((await db.select().from(schema.instagramCommentLogs).where(inArray(schema.instagramCommentLogs.companyId, ownedCompanyIds))).length, 1)
})

test('lead existente: envio não consulta chave, tag pessoa ou slug, nem exige corte de data', async () => {
  await pausedLead(commonId)
  queries.length = 0
  assert.equal((await comment(commonId, { commentCreatedAt: '2000-01-01' })).status, 'sent')
  const selects = queries.filter(query => query.startsWith('select'))
  assert.equal(selects.some(query => /company_pause_switches|lead_tags|"companies"/.test(query)), false)
  assert.equal(dmCalls().length, 1)
})

test('opt-out surgido durante follow check barra o envio e registra o bloqueio', async () => {
  await pausedLead(commonId)
  await db.update(schema.instagramCommentAutomations).set({ requireFollowCheck: true }).where(eq(schema.instagramCommentAutomations.companyId, commonId))
  duringFollowCheck = async () => {
    await db.update(schema.recoveryLeads).set({ botPausedBy: 'optout_whatsapp' }).where(eq(schema.recoveryLeads.companyId, commonId))
  }
  assert.equal((await comment()).reason, 'optout')
  assert.equal(dmCalls().length, 0)
  assert.equal((await db.select().from(schema.instagramCommentLogs).where(inArray(schema.instagramCommentLogs.companyId, ownedCompanyIds)))[0].status, 'blocked')
})

// Reprodução controlada da corrida: a leitura Graph só termina após o
// processador retornar, sem depender da carga da máquina ou de sleep.
test('resposta pública pendente é drenada antes das asserções e da limpeza', async () => {
  let releaseMedia!: () => void
  const mediaGate = new Promise<void>(resolve => { releaseMedia = resolve })
  duringMediaRead = () => mediaGate
  try {
    assert.equal((await processComment({
      companyId: commonId, commentId: 'c1', commenterId: 'person', mediaId: '12345',
      commentText: 'quero', source: 'instagram_webhook', commentCreatedAt: new Date(),
    })).status, 'sent')
    assert.equal(dmCalls().length, 1)
    assert.equal(graph.filter(call => call.url.endsWith('/replies')).length, 0)
    assert.equal(sideEffects.length, 2, 'reply e hide têm promessas próprias fora do retorno do processador')
  } finally {
    releaseMedia()
    await drainSideEffects()
  }
  assert.equal(graph.filter(call => call.url.endsWith('/replies')).length, 1)
  assert.equal(graph.filter(call => call.body.hide === true).length, 1)
  assert.equal(sideEffects.length, 0)
})
