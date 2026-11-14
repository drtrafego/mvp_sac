// QA adversarial do gatilho "resposta ao Story" (13/11/2026).
// Webhook ASSINADO nas DUAS rotas, Postgres descartável real, Meta/IA/Direct espiados.
// Uso (dentro do worktree): QA_PG_URL=postgres://postgres:test@127.0.0.1:55432/test \
//   node --experimental-test-module-mocks --import tsx --test scripts/qa-todas-webhook.test.ts
// Pré-requisito: schema real aplicado (drizzle-kit push) + drizzle/0045 aplicado.
// Sem QA_PG_URL sai limpo: o fluxo completo de webhook requer Postgres completo, não PGlite.
import { test, mock, before, after as afterAll } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../src/lib/db/schema'
import { PgDialect } from 'drizzle-orm/pg-core'
const dialect = new PgDialect()
import { NextRequest as RealNextRequest, NextResponse as RealNextResponse } from 'next/server'

const URL_PG = process.env.QA_PG_URL
if (!URL_PG) { console.log('SKIP qa-todas-webhook: defina QA_PG_URL para executar contra Postgres descartável.'); process.exit(0) }
const SECRET = 'qa-secret'
const MIGRATION = readFileSync(path.resolve(__dirname, '../drizzle/0045_instagram_story_trigger.sql'), 'utf8')

const client = postgres(URL_PG, { max: 20, onnotice: () => {} })
const rawDb = drizzle(client, { schema })
const queryLog: string[] = []
let failStoryQueries = false
let neonShape = false
const dbProxy = new Proxy(rawDb, {
  get(target, prop) {
    if (prop === 'execute') {
      return async (q: { queryChunks?: unknown[] }) => {
        const text = JSON.stringify(q.queryChunks ?? q)
        queryLog.push('execute:' + text.replace(/\s+/g, ' ').slice(0, 160))
        if (failStoryQueries && text.includes('instagram_story')) throw new Error('boom: banco indisponível (simulado)')
        // emula o neon-http: Date em parâmetro bruto vira string ISO (prepareValue do driver neon)
        const built = dialect.sqlToQuery(q as never)
        const r = await client.unsafe(built.sql, built.params.map(p => (p instanceof Date ? p.toISOString() : p)) as never)
        return neonShape ? { rows: Array.from(r as unknown as unknown[]) } : Array.from(r as unknown as unknown[])
      }
    }
    const v = Reflect.get(target, prop)
    return typeof v === 'function' ? v.bind(target) : v
  },
})

const sendCalls: Array<{ recipientId: string; text?: string; companyId: number; reservedAtCall: string[] }> = []
const aiCalls: number[] = []
const kwCalls: string[] = []
const followCalls: number[] = []
const commentCalls: string[] = []
let sendBehavior: () => Promise<Record<string, unknown>> = async () => ({ ok: true, messageId: `mid_out_${sendCalls.length}` })
const afterPromises: Promise<unknown>[] = []

mock.module('@/lib/db', { namedExports: { db: dbProxy } })
mock.module('@/lib/instagram', {
  namedExports: {
    sendInstagramMessage: async (p: { recipientId: string; text?: string; companyId: number }) => {
      const reserved = await client`select status from instagram_story_deliveries where sender_id = ${p.recipientId.replace(/^ig_/, '')}`
      sendCalls.push({ ...p, reservedAtCall: reserved.map(r => r.status as string) })
      return sendBehavior()
    },
    fetchInstagramUserProfile: async () => ({ ok: false }),
    sendInstagramPrivateReply: async () => ({ ok: true, messageId: 'x' }),
    checkInstagramUserFollowsBusiness: async () => ({ ok: true, follows: true }),
    replyInstagramCommentPublic: async () => ({ ok: true }),
    hideInstagramComment: async () => ({ ok: true }),
  },
})
mock.module('@/lib/ai-reply', { namedExports: { generateAndSendAiReply: async (id: number) => { aiCalls.push(id) } } })
mock.module('@/lib/instagram-comment-processor', {
  namedExports: {
    processInstagramDirectKeyword: async (p: { messageId: string }) => { kwCalls.push(p.messageId); return { matched: false } },
    handleFollowCheckReply: async (p: { leadId: number }) => { followCalls.push(p.leadId) },
    processInstagramComment: async (p: { commentId: string }) => { commentCalls.push(p.commentId) },
  },
})
mock.module('next/server', {
  namedExports: {
    NextRequest: RealNextRequest,
    NextResponse: RealNextResponse,
    after: (fn: () => unknown) => { afterPromises.push(Promise.resolve().then(fn)) },
  },
})

const sign = (raw: string) => 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex')
const ISA = { slug: 'isabela-fanini', ig: 'IG_ISA' }
const OUT = { slug: 'outra-empresa', ig: 'IG_OUT' }
let isaId = 0, outId = 0, routeSlug: (r: Request, s: string) => Promise<Response>, routeGlobal: (r: Request) => Promise<Response>

type Item = { sender?: string; mid?: string; text?: string; story?: unknown; ts?: number; extra?: Record<string, unknown>; replyTo?: unknown; isStoryReply?: boolean; isEcho?: boolean; reaction?: unknown }
function messaging(co: typeof ISA, it: Item) {
  const message: Record<string, unknown> = { mid: it.mid ?? 'mid_default', ...(it.text !== undefined ? { text: it.text } : {}) }
  if (it.story !== undefined) message.reply_to = { story: it.story }
  if (it.replyTo !== undefined) message.reply_to = it.replyTo
  if (it.isStoryReply) message.is_story_reply = true
  if (it.isEcho) message.is_echo = true
  const item: Record<string, unknown> = { sender: { id: it.sender ?? 'U1' }, recipient: { id: co.ig }, timestamp: it.ts ?? Date.now() - 30_000, ...(it.reaction ? { reaction: it.reaction } : { message }), ...(it.extra ?? {}) }
  return item
}
async function deliver(which: 'slug' | 'global', co: typeof ISA, items: Item[], opts: { raw?: string } = {}) {
  const body = { object: 'instagram', entry: [{ id: co.ig, time: Date.now(), messaging: items.map(i => messaging(co, i)) }] }
  const raw = opts.raw ?? JSON.stringify(body)
  const headers = { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) }
  const res = which === 'slug'
    ? await routeSlug(new RealNextRequest(`https://sac.test/api/webhooks/instagram/${co.slug}`, { method: 'POST', headers, body: raw }), co.slug)
    : await routeGlobal(new RealNextRequest('https://sac.test/api/webhooks/instagram', { method: 'POST', headers, body: raw }))
  await Promise.all(afterPromises.splice(0))
  return res
}
async function reset() {
  await client`truncate whatsapp_messages, lead_tags, recovery_leads, instagram_story_deliveries, instagram_story_automations, company_pause_switches, webhook_received restart identity cascade`.catch(async () => {
    await client`truncate whatsapp_messages, lead_tags, recovery_leads, webhook_received restart identity cascade`
    await client`truncate company_pause_switches restart identity cascade`.catch(() => {})
  })
  sendCalls.length = 0; aiCalls.length = 0; kwCalls.length = 0; followCalls.length = 0; commentCalls.length = 0; queryLog.length = 0
  sendBehavior = async () => ({ ok: true, messageId: `mid_out_${sendCalls.length}` })
  failStoryQueries = false; neonShape = false
  delete process.env.ISABELA_FORWARD_ONLY_SINCE
}
async function rule(over: Record<string, unknown> = {}) {
  const v = { company_id: isaId, name: 'r', keywords: [] as string[], match_type: 'any', story_id: null as string | null, dm_message: 'DM-AUTO', mode: 'send', is_active: true, enabled_at: new Date(Date.now() - 3_600_000), ...over }
  const [r] = await client`insert into instagram_story_automations (company_id,name,keywords,match_type,story_id,dm_message,mode,is_active,enabled_at) values (${v.company_id as number},${v.name as string},${client.array(v.keywords as string[])},${v.match_type as string},${v.story_id as string | null},${v.dm_message as string},${v.mode as string},${v.is_active as boolean},${v.enabled_at ? (v.enabled_at as Date).toISOString() : null}::timestamptz) returning id`
  return r.id as number
}
const deliveries = () => client`select * from instagram_story_deliveries order by id`
const noAi = () => { assert.equal(aiCalls.length, 0, 'IA NÃO pode ser chamada'); assert.equal(kwCalls.length, 0, 'direct-keyword NÃO'); assert.equal(followCalls.length, 0, 'follow-check NÃO') }
const leadOf = async (sender: string) => (await client`select * from recovery_leads where phone = ${'ig_' + sender}`)[0]

async function boot() {
  await client`drop table if exists instagram_story_deliveries, instagram_story_automations cascade`
  await client.unsafe(MIGRATION)
  await client`truncate companies restart identity cascade`
  const [a] = await client`insert into companies (name, slug) values ('Isabela', ${ISA.slug}) returning id`
  const [b] = await client`insert into companies (name, slug) values ('Outra', ${OUT.slug}) returning id`
  isaId = a.id; outId = b.id
  for (const [id, co] of [[isaId, ISA], [outId, OUT]] as const) {
    await client`insert into settings (company_id, instagram_username, instagram_access_token, instagram_account_id, instagram_app_secret) values (${id}, 'x', 'tok', ${co.ig}, ${SECRET})`
  }
  const slugMod = await import('../src/app/api/webhooks/instagram/[slug]/route')
  const globMod = await import('../src/app/api/webhooks/instagram/route')
  routeSlug = (r, s) => slugMod.POST(r as never, { params: Promise.resolve({ slug: s }) }) as Promise<Response>
  routeGlobal = r => globMod.POST(r as never) as Promise<Response>
}


// ===== QA "story para todas as empresas" (independente) =====
const captured: string[] = []
for (const m of ['error', 'warn', 'log', 'info'] as const) { const orig = console[m].bind(console); console[m] = (...a: unknown[]) => { captured.push(a.map(x => (x instanceof Error ? `${x.name}: ${x.message}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); orig(...a) } }

for (const which of ['slug', 'global'] as const) {
  const T = (n: string, fn: () => Promise<void>) => test(`[${which}] ${n}`, async () => { await reset(); captured.length = 0; await fn() })
  let seq = 0; const mid = () => `midT_${which}_${++seq}_${Math.random().toString(36).slice(2, 7)}`
  const story = (sender: string, extra: Partial<Item> = {}): Item => ({ sender, mid: mid(), text: 'oi', story: { id: '555' }, ...extra })
  const ruleO = (over: Record<string, unknown> = {}) => rule({ company_id: outId, ...over })
  const aiFor = async (sender: string) => { const l = await leadOf(sender); return aiCalls.filter(id => id === l.id).length }

  T('OUTRA: send, lead livre, sem pausa -> 1 DM e IA NÃO chamada (BLOQUEIO R-1 se falhar)', async () => {
    await ruleO(); const r = await deliver(which, OUT, [story('N1')]); assert.equal(r.status, 200)
    const d = await deliveries(); assert.equal(sendCalls.length, 1, 'DM enviada? deliveries=' + JSON.stringify(d.map(x => [x.status, x.reason]))); assert.equal(aiCalls.length, 0); assert.equal(kwCalls.length, 0); assert.equal(followCalls.length, 0)
    const [m] = await client`select send_state, sent_by, sender_name from whatsapp_messages where direction='outbound'`; assert.deepEqual([m.send_state, m.sent_by, m.sender_name], ['accepted', 'bot', 'Automação de Story'])
  })
  T('OUTRA sem regra: IA 1x, 200, 1 skipped, mesmo lead; sem DM', async () => {
    const r = await deliver(which, OUT, [story('N2')]); assert.equal(r.status, 200); assert.equal(await aiFor('N2'), 1); assert.equal(sendCalls.length, 0)
    const d = await deliveries(); assert.equal(d.length, 1); assert.equal(d[0].status, 'skipped')
    assert.equal(queryLog.filter(q => q.includes('FROM instagram_story_automations')).length, 1, 'uma leitura de regras por resposta a story')
  })
  T('OUTRA: inativa, não casa, enabled_at futuro/null, fora da janela -> IA 1x cada, 0 DM', async () => {
    const cases: Array<[string, Record<string, unknown>, Partial<Item>]> = [
      ['inativa', { is_active: false }, {}], ['não casa', { match_type: 'exact', keywords: ['xyz'] }, {}], ['enabled futuro', { enabled_at: new Date(Date.now() + 600_000) }, {}],
      ['enabled null', { enabled_at: null }, {}], ['janela', { enabled_at: new Date(Date.now() - 3 * 86_400_000) }, { ts: Date.now() - 26 * 3_600_000 }], ['story diferente', { story_id: '999' }, {}],
    ]
    for (const [i, [name, over, extra]] of cases.entries()) { await reset(); captured.length = 0; await ruleO(over); await deliver(which, OUT, [story('C' + i, extra)]); assert.equal(await aiFor('C' + i), 1, name + ': IA deve ser chamada'); assert.equal(sendCalls.length, 0, name) }
  })
  T('OUTRA: observe -> observed gravado E IA chamada', async () => {
    await ruleO({ mode: 'observe' }); await deliver(which, OUT, [story('O1')]); assert.equal(await aiFor('O1'), 1); assert.equal(sendCalls.length, 0); assert.equal((await deliveries())[0].status, 'observed')
  })
  T('OUTRA: story sem id / sem data -> IA 1x', async () => {
    await ruleO(); await deliver(which, OUT, [{ sender: 'S1', mid: mid(), text: 'oi', isStoryReply: true }]); assert.equal(await aiFor('S1'), 1); assert.equal(sendCalls.length, 0)
  })
  T('OUTRA: erro de banco e tabela inexistente -> 200 e IA 1x cada', async () => {
    await ruleO(); failStoryQueries = true; const r = await deliver(which, OUT, [story('E1')]); assert.equal(r.status, 200); assert.equal(await aiFor('E1'), 1); failStoryQueries = false
    await client`drop table instagram_story_deliveries, instagram_story_automations cascade`
    try { const r2 = await deliver(which, OUT, [story('E2')]); assert.equal(r2.status, 200); assert.equal(await aiFor('E2'), 1); assert.equal(sendCalls.length, 0) } finally { await client.unsafe(MIGRATION) }
  })
  T('OUTRA: 20 concorrentes mesmo mid (2 rotas) = 1 DM, IA 0 para o story', async () => {
    await ruleO(); const m = mid()
    await Promise.all(Array.from({ length: 20 }, (_, i) => deliver(i % 2 ? 'slug' : 'global', OUT, [story('K1', { mid: m })])))
    assert.equal(sendCalls.length, 1); assert.equal(await aiFor('K1'), 0)
  })
  T('OUTRA: 3 mensagens distintas simultâneas da mesma pessoa/story = 1 DM', async () => {
    await ruleO(); await Promise.all([deliver(which, OUT, [story('K2')]), deliver(which, OUT, [story('K2')]), deliver('slug', OUT, [story('K2')])]); assert.equal(sendCalls.length, 1)
  })
  T('OUTRA: reentrega 21x do mesmo mid = 1 DM, IA 0', async () => {
    await ruleO(); const m = mid(); for (let i = 0; i < 21; i++) await deliver(which, OUT, [story('D1', { mid: m })]); assert.equal(sendCalls.length, 1); assert.equal(await aiFor('D1'), 0)
  })
  T('OUTRA: envio incerto (timeout / sem message_id) nunca reenvia e não vai à IA', async () => {
    await ruleO(); sendBehavior = async () => ({ ok: false, uncertain: true, isTimeout: true, error: 't' }); await deliver(which, OUT, [story('U1')]); await deliver(which, OUT, [story('U1')]); assert.equal(sendCalls.length, 1); assert.equal(await aiFor('U1'), 0)
    sendBehavior = async () => ({ ok: true }); await deliver(which, OUT, [story('U2')]); await deliver(which, OUT, [story('U2')]); assert.equal(sendCalls.length, 2); assert.equal(await aiFor('U2'), 0)
  })
  T('INFO: OUTRA: 2ª resposta ao MESMO story depois do DM (mid diferente) -> vai à IA? (observado)', async () => {
    await ruleO(); await deliver(which, OUT, [story('P1')]); await deliver(which, OUT, [story('P1', { text: 'e qual o preço?' })]); console.log(`   2ª resposta ao mesmo story: IA chamada ${await aiFor('P1')}x, DMs ${sendCalls.length}`)
    assert.equal(await aiFor('P1'), 1, '2ª mensagem DIFERENTE da pessoa (pergunta nova) não pode sumir sem resposta')
  })
  T('INFO: OUTRA: transporte falhou com certeza (ok:false) -> cliente fica sem DM e sem IA? (observado)', async () => {
    await ruleO(); sendBehavior = async () => ({ ok: false, error: 'HTTP 400' }); await deliver(which, OUT, [story('F1')]); console.log(`   falha certa: IA ${await aiFor('F1')}x, DMs tentadas ${sendCalls.length}`)
    assert.equal(await aiFor('F1'), 1, 'falha certa do transporte deveria devolver a mensagem à IA')
  })
  T('PAUSA: OUTRA com "Pausar tudo" ligado: 0 DM; IA 0 (lead pausado pela chave, como hoje)', async () => {
    await ruleO(); await client`insert into company_pause_switches (company_id, scope, active, paused_by) values (${outId}, 'all', true, 'dono')`
    await deliver(which, OUT, [story('X1')]); assert.equal(sendCalls.length, 0); assert.equal(await aiFor('X1'), 0); assert.equal(kwCalls.length, 1, 'direct-keyword segue como hoje')
  })
  T('PAUSA: OUTRA com bot desligado no lead (botão do SAC), tag pessoa: 0 DM, 0 IA', async () => {
    await ruleO(); await deliver(which, OUT, [story('B0')]); sendCalls.length = 0; await client`delete from instagram_story_deliveries`
    await client`update recovery_leads set bot_paused = true, bot_paused_by = 'Fulana', bot_paused_all = false where phone = 'ig_B0'`
    aiCalls.length = 0; await deliver(which, OUT, [story('B0')]); assert.equal(sendCalls.length, 0); assert.equal(aiCalls.length, 0)
    await client`update recovery_leads set bot_paused = false, bot_paused_by = null where phone = 'ig_B0'`; const l = await leadOf('B0'); await client`insert into lead_tags (lead_id, tag, created_by) values (${l.id}, 'pessoa', 'qa')`
    await client`delete from instagram_story_deliveries`; await deliver(which, OUT, [story('B0')]); assert.equal(sendCalls.length, 0)
  })
  T('PAUSA: pausa do canal instagram ligada (scope instagram) em OUTRA -> 0 DM', async () => {
    await ruleO(); await client`insert into company_pause_switches (company_id, scope, active, paused_by) values (${outId}, 'instagram', true, 'dono')`; await deliver(which, OUT, [story('X2')]); assert.equal(sendCalls.length, 0)
  })
  T('OUTRA: lead antes/depois: story com send não altera bot_paused* do lead', async () => {
    await deliver(which, OUT, [{ sender: 'CTRL2', mid: mid(), text: 'oi', story: { id: '1' } }]); const c = await leadOf('CTRL2'); await ruleO(); await deliver(which, OUT, [story('Z9')]); const l = await leadOf('Z9')
    for (const k of ['bot_paused', 'bot_paused_by', 'bot_paused_all', 'bot_paused_channel'] as const) assert.equal(String(l[k] ?? null), String(c[k] ?? null))
  })
  T('ISABELA continua fail-closed: send/observe/sem regra/erro/sem id/tabela -> IA 0 (matriz curta)', async () => {
    await deliver(which, ISA, [story('I1')]); await rule({ mode: 'observe' }); await deliver(which, ISA, [story('I2')]); await client`delete from instagram_story_automations`; await rule(); await deliver(which, ISA, [story('I3'), { sender: 'I4', mid: mid(), text: 'x', isStoryReply: true }])
    failStoryQueries = true; await deliver(which, ISA, [story('I5')]); failStoryQueries = false
    await client`drop table instagram_story_deliveries, instagram_story_automations cascade`; try { await deliver(which, ISA, [story('I6')]) } finally { await client.unsafe(MIGRATION) }
    noAi()
  })
  T('LOG: nenhum IGSID/mid/texto/params em console durante erros (OUTRA e ISABELA)', async () => {
    await ruleO(); failStoryQueries = true; await deliver(which, OUT, [story('LOGSND1', { mid: 'MIDSEC1', text: 'TXTSEC' })]); await deliver(which, ISA, [story('LOGSND2', { mid: 'MIDSEC2', text: 'TXTSEC' })]); failStoryQueries = false
    const lines = captured.filter(l => /Story/.test(l)); console.log('   logs do gatilho:', JSON.stringify(lines)); for (const l of lines) assert.ok(!/LOGSND|MIDSEC|TXTSEC|params|Failed query/i.test(l), l)
  })
}
before(boot)
afterAll(async () => { await client.end({ timeout: 2 }) })
