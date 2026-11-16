// Postgres real e transporte real com Graph interceptada, sem acesso à Meta.
// Ordem do Gastão em 16/11/2026: pausar é só o bot, não a DM fixa do Story.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, beforeEach, mock, test } from 'node:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { PgDialect } from 'drizzle-orm/pg-core'
import * as schema from '../src/lib/db/schema'

const pgUrl = process.env.QA_PG_URL
if (!pgUrl) throw new Error('Defina QA_PG_URL para um Postgres descartável com o schema aplicado.')
const client = postgres(pgUrl, { max: 5, onnotice: () => {} })
const rawDb = drizzle(client, { schema })
const dialect = new PgDialect()
let failAt: 'rules' | 'reservation' | 'lead' | null = null
const db = new Proxy(rawDb, {
  get(target, prop) {
    if (prop === 'execute') return async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
      const built = dialect.sqlToQuery(query)
      if ((failAt === 'rules' && built.sql.includes('FROM instagram_story_automations')) ||
          (failAt === 'reservation' && built.sql.includes('ON CONFLICT'))) throw new Error('Falha de banco simulada')
      return Array.from(await client.unsafe(built.sql, built.params.map(p => p instanceof Date ? p.toISOString() : p) as never))
    }
    if (prop === 'select' && failAt === 'lead') return () => { throw new Error('Falha na releitura do lead') }
    const value = Reflect.get(target, prop)
    return typeof value === 'function' ? value.bind(target) : value
  },
})
mock.module('@/lib/db', { namedExports: { db } })

type Input = Parameters<typeof import('../src/lib/instagram-story-trigger')['handleInstagramStoryReplyItem']>[0]
let handle: (input: Input) => Promise<boolean>
let commonId: number, isabelaId: number
const originalFetch = globalThis.fetch
const graphCalls: Array<{ url: string; method?: string; auth: string | null; body: unknown; reserved: number }> = []
let graphMode: 'sent' | 'failed' | 'timeout' | 'no-id' = 'sent'

before(async () => {
  await client`drop table if exists instagram_story_deliveries, instagram_story_automations cascade`
  await client.unsafe(readFileSync(new URL('../drizzle/0045_instagram_story_trigger.sql', import.meta.url), 'utf8'))
  await client`truncate companies restart identity cascade`
  const companies = await client`insert into companies (name, slug) values ('Comum', 'story-comum'), ('Isabela', 'isabela-fanini') returning id`
  commonId = companies[0].id; isabelaId = companies[1].id
  for (const id of [commonId, isabelaId]) {
    await client`insert into settings (company_id, instagram_account_id, instagram_access_token) values (${id}, ${'QA_ACCOUNT_' + id}, ${'qa-token-' + id})`
  }
  globalThis.fetch = async (url, init) => {
    const [{ count }] = await client`select count(*)::int as count from instagram_story_deliveries where status = 'reserved'`
    graphCalls.push({ url: String(url), method: init?.method, auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)), reserved: count })
    if (graphMode === 'timeout') throw Object.assign(new Error('Timeout simulado'), { name: 'TimeoutError' })
    if (graphMode === 'failed') return Response.json({ error: { message: 'Rejeição simulada' } }, { status: 400 })
    return Response.json(graphMode === 'no-id' ? {} : { message_id: `qa-out-${graphCalls.length}` })
  }
  handle = (await import('../src/lib/instagram-story-trigger')).handleInstagramStoryReplyItem
})
beforeEach(async () => {
  failAt = null; graphMode = 'sent'; graphCalls.length = 0
  await client`truncate recovery_leads, lead_tags, whatsapp_messages, instagram_story_automations, instagram_story_deliveries, company_pause_switches restart identity cascade`
})
after(async () => { globalThis.fetch = originalFetch; await client.end({ timeout: 2 }) })

async function seed(companyId: number, slug: string): Promise<Input> {
  const [lead] = await client`insert into recovery_leads (company_id, phone, channel, event_type) values (${companyId}, 'ig_QA_SENDER', 'instagram', 'instagram_direct') returning id`
  await client`insert into instagram_story_automations (company_id, name, keywords, match_type, dm_message, mode, is_active, enabled_at)
    values (${companyId}, 'Regra QA', ARRAY['quero'], 'exact', ${'DM fixa ' + companyId}, 'send', true, now() - interval '3 days')`
  return { companyId, companySlug: slug, senderId: 'QA_SENDER', message: { mid: 'qa-mid', text: 'QUERO', reply_to: { story: { id: '123' } } }, itemTimestamp: Date.now() - 1000, lead: { id: lead.id, botPaused: false } }
}
const deliveries = () => client`select * from instagram_story_deliveries order by id`
async function assertSent(input: Input) {
  assert.equal(graphCalls.length, 1, 'exatamente uma DM pela Graph interceptada')
  assert.deepEqual(graphCalls[0], {
    url: `https://graph.instagram.com/v21.0/QA_ACCOUNT_${input.companyId}/messages`, method: 'POST', auth: `Bearer qa-token-${input.companyId}`,
    body: { recipient: { id: 'QA_SENDER' }, message: { text: `DM fixa ${input.companyId}` } }, reserved: 1,
  })
  const rows = await deliveries()
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'sent'); assert.equal(rows[0].reason, null)
  assert.equal(rows[0].company_id, input.companyId); assert.equal(rows[0].message_mid, 'qa-mid'); assert.equal(rows[0].outbound_message_id, 'qa-out-1')
  const messages = await client`select * from whatsapp_messages where direction = 'outbound'`
  assert.equal(messages.length, 1); assert.equal(messages[0].lead_id, input.lead?.id); assert.equal(messages[0].company_id, input.companyId)
  assert.equal(messages[0].send_state, 'accepted'); assert.equal(messages[0].sender_name, 'Automação de Story')
}

for (const slug of ['story-comum', 'isabela-fanini']) {
  const protectedCompany = slug === 'isabela-fanini'
  const inputFor = () => seed(protectedCompany ? isabelaId : commonId, slug)
  for (const pause of ['lead', 'botPausedAll', 'chave geral', 'chave instagram', 'pessoa', 'todas'] as const) {
    test(`${slug}: ${pause} permite 1 DM sent; mesmo mid não duplica e a pausa permanece`, async () => {
      const input = await inputFor()
      if (pause === 'lead' || pause === 'todas') await client`update recovery_leads set bot_paused = true, bot_paused_by = 'atendente' where id = ${input.lead!.id!}`
      if (pause === 'botPausedAll' || pause === 'todas') await client`update recovery_leads set bot_paused = true, bot_paused_all = true where id = ${input.lead!.id!}`
      if (pause === 'chave geral' || pause === 'todas') await client`insert into company_pause_switches (company_id, scope, active) values (${input.companyId}, 'all', true)`
      if (pause === 'chave instagram' || pause === 'todas') await client`insert into company_pause_switches (company_id, scope, active) values (${input.companyId}, 'instagram', true)`
      if (pause === 'pessoa' || pause === 'todas') await client`insert into lead_tags (lead_id, tag, created_by) values (${input.lead!.id!}, 'pessoa', 'qa')`
      const snapshot = async () => ({ leads: await client`select * from recovery_leads order by id`, switches: await client`select * from company_pause_switches order by id`, tags: await client`select * from lead_tags order by id` })
      const before = await snapshot()
      assert.equal(await handle(input), true)
      assert.equal(await handle(input), true, 'reentrega do mesmo mid deve continuar consumida')
      await assertSent(input)
      assert.deepEqual(await snapshot(), before, 'a automação não modifica os campos de pausa nem as tags')
    })
  }
  for (const guard of ['observe', '24h', 'enabled_at', 'sem regra'] as const) {
    test(`${slug}: ${guard} preservado mesmo com lead pausado`, async () => {
      const input = await inputFor()
      await client`update recovery_leads set bot_paused = true where id = ${input.lead!.id!}`
      if (guard === 'observe') await client`update instagram_story_automations set mode = 'observe'`
      if (guard === '24h') input.itemTimestamp = Date.now() - 24 * 60 * 60 * 1000
      if (guard === 'enabled_at') await client`update instagram_story_automations set enabled_at = now()`
      if (guard === 'sem regra') await client`delete from instagram_story_automations`
      assert.equal(await handle(input), protectedCompany)
      assert.equal(graphCalls.length, 0)
      const [delivery] = await deliveries()
      assert.equal(delivery.status, guard === 'observe' ? 'observed' : 'skipped')
      const reason = { observe: /Modo teste/, '24h': /janela de 24 horas/, enabled_at: /anterior à ativação/, 'sem regra': /Nenhuma regra/ }[guard]
      assert.match(delivery.reason, reason)
    })
  }
  for (const missing of ['sem id', 'excluído', 'outra empresa'] as const) {
    test(`${slug}: lead ${missing} não reserva nem envia`, async () => {
      const input = await inputFor()
      if (missing === 'sem id') input.lead = null
      if (missing === 'excluído') await client`delete from recovery_leads where id = ${input.lead!.id!}`
      if (missing === 'outra empresa') await client`update recovery_leads set company_id = ${protectedCompany ? commonId : isabelaId} where id = ${input.lead!.id!}`
      assert.equal(await handle(input), protectedCompany); assert.equal(graphCalls.length, 0)
      const rows = await deliveries(); assert.equal(rows.length, 1); assert.equal(rows[0].status, 'skipped'); assert.match(rows[0].reason, /Lead não encontrado/)
      assert.equal((await client`select * from whatsapp_messages`).length, 0)
    })
  }
  for (const failure of ['rules', 'reservation', 'lead'] as const) {
    test(`${slug}: erro de banco em ${failure} mantém o fallback e não envia`, async () => {
      const input = await inputFor(); failAt = failure
      assert.equal(await handle(input), protectedCompany); assert.equal(graphCalls.length, 0)
      assert.equal((await deliveries()).length, 0)
    })
  }
}

test('reservas, regras, tokens e Inbox são isolados por empresa, mesmo sender/story/mid', async () => {
  const common = await seed(commonId, 'story-comum')
  const isabela = await seed(isabelaId, 'isabela-fanini')
  await client`update instagram_story_automations set is_active = false where company_id = ${commonId}`
  assert.equal(await handle(common), false, 'não pode usar regra ativa de outra empresa'); assert.equal(graphCalls.length, 0)
  await client`delete from instagram_story_deliveries`
  await client`update instagram_story_automations set is_active = true where company_id = ${commonId}`
  assert.equal(await handle(common), true); assert.equal(await handle(isabela), true)
  assert.equal(await handle(common), true); assert.equal(await handle(isabela), true)
  assert.equal(graphCalls.length, 2)
  assert.deepEqual(graphCalls.map(c => c.auth), [`Bearer qa-token-${commonId}`, `Bearer qa-token-${isabelaId}`])
  assert.deepEqual(graphCalls.map(c => c.body), [commonId, isabelaId].map(id => ({ recipient: { id: 'QA_SENDER' }, message: { text: `DM fixa ${id}` } })))
  const rows = await deliveries(); assert.equal(rows.length, 2); assert.ok(rows.every(r => r.status === 'sent'))
  const messages = await client`select company_id, lead_id from whatsapp_messages order by id`
  assert.deepEqual(Array.from(messages), [{ company_id: commonId, lead_id: common.lead!.id }, { company_id: isabelaId, lead_id: isabela.lead!.id }])
})

test('empresa comum: mid diferente após envio volta ao fluxo normal, sem segunda DM', async () => {
  const input = await seed(commonId, 'story-comum')
  assert.equal(await handle(input), true)
  assert.equal(await handle({ ...input, message: { ...input.message, mid: 'outro-mid' } }), false)
  await assertSent(input)
})

test('empresa comum: falha certa não consome a mensagem; entrega failed não reenvia', async () => {
  const input = await seed(commonId, 'story-comum'); graphMode = 'failed'
  assert.equal(await handle(input), false)
  assert.equal(await handle({ ...input, message: { ...input.message, mid: 'outro-mid' } }), false)
  assert.equal(graphCalls.length, 1); assert.equal((await deliveries())[0].status, 'failed')
  assert.equal((await client`select * from whatsapp_messages`).length, 0)
})

for (const mode of ['timeout', 'no-id'] as const) {
  test(`empresa comum: ${mode} fica unknown e nunca reenvia, inclusive mid diferente`, async () => {
    const input = await seed(commonId, 'story-comum'); graphMode = mode
    assert.equal(await handle(input), true); assert.equal(await handle(input), true)
    assert.equal(await handle({ ...input, message: { ...input.message, mid: 'outro-mid' } }), true)
    assert.equal(graphCalls.length, 1); assert.equal((await deliveries())[0].status, 'unknown')
    const messages = await client`select * from whatsapp_messages`
    assert.equal(messages.length, 1); assert.equal(messages[0].send_state, 'uncertain'); assert.equal(messages[0].lead_id, input.lead!.id)
  })
}
