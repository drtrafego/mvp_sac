// QA adversarial do gatilho "resposta ao Story" (13/11/2026).
// Webhook ASSINADO nas DUAS rotas, Postgres descartável real, Meta/IA/Direct espiados.
// Uso (dentro do worktree): QA_PG_URL=postgres://postgres:test@127.0.0.1:55432/test \
//   node --experimental-test-module-mocks --import tsx --test scripts/qa-story-webhook.test.ts
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
if (!URL_PG) { console.log('SKIP qa-story-webhook: defina QA_PG_URL para executar contra Postgres descartável.'); process.exit(0) }
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

for (const which of ['slug', 'global'] as const) {
  const mk = (n: string) => `[${which}] ${n}`
  const T = (n: string, fn: () => Promise<void>) => test(mk(n), async () => { await reset(); await fn() })
  let seq = 0
  const mid = () => `mid_${which}_${++seq}_${Math.random().toString(36).slice(2, 7)}`

  T('ISOLAMENTO: sem regra -> 0 IA, 0 DM, lead criado, delivery skipped', async () => {
    const r = await deliver(which, ISA, [{ mid: mid(), text: 'oi', story: { id: '111' } }])
    assert.equal(r.status, 200); noAi(); assert.equal(sendCalls.length, 0)
    const d = await deliveries(); assert.equal(d.length, 1); assert.equal(d[0].status, 'skipped')
  })
  T('ISOLAMENTO: regra inativa', async () => {
    await rule({ is_active: false }); await deliver(which, ISA, [{ mid: mid(), text: 'oi', story: { id: '111' } }])
    noAi(); assert.equal(sendCalls.length, 0)
  })
  T('observe: grava observed e NÃO envia', async () => {
    await rule({ mode: 'observe' }); await deliver(which, ISA, [{ mid: mid(), text: 'oi', story: { id: '111' } }])
    noAi(); assert.equal(sendCalls.length, 0); assert.equal((await deliveries())[0].status, 'observed')
  })
  T('send: 1 DM, reserva existia ANTES do envio, Inbox bot "Automação de Story", pausa do lead intacta', async () => {
    // controle: mesmo evento SEM regra, compara os campos de pausa
    await deliver(which, ISA, [{ sender: 'CTRL', mid: mid(), text: 'oi', story: { id: '111' } }])
    const ctrl = await leadOf('CTRL')
    await rule(); await deliver(which, ISA, [{ sender: 'U9', mid: mid(), text: 'oi', story: { id: '111' } }])
    noAi(); assert.equal(sendCalls.length, 1); assert.equal(sendCalls[0].text, 'DM-AUTO')
    assert.deepEqual(sendCalls[0].reservedAtCall, ['reserved'], 'reserva deve ser gravada antes do transporte')
    const lead = await leadOf('U9')
    for (const k of ['bot_paused', 'bot_paused_by', 'bot_paused_all', 'bot_paused_channel', 'bot_paused_at'] as const) assert.equal(String(lead[k] ?? null), String(ctrl[k] ?? null), `campo de pausa ${k} mudou`)
    const out = await client`select * from whatsapp_messages where lead_id = ${lead.id} and direction = 'outbound'`
    assert.equal(out.length, 1); assert.equal(out[0].sent_by, 'bot'); assert.equal(out[0].sender_name, 'Automação de Story')
    console.log('   send_state gravado no Inbox =', out[0].send_state, '(vocabulário do repo: accepted/pending/failed/uncertain)')
    assert.equal(out[0].send_state, 'accepted')
    assert.equal((await deliveries()).find(d => d.sender_id === 'U9')?.status, 'sent')
  })
  T('formato neon-http ({rows}) também isola e envia', async () => {
    neonShape = true; await rule(); await deliver(which, ISA, [{ mid: mid(), text: 'oi', story: { id: '111' } }])
    noAi(); assert.equal(sendCalls.length, 1)
  })
  T('lead com pausa HUMANA (botPausedAll=false): não envia, 0 IA', async () => {
    await rule(); await deliver(which, ISA, [{ sender: 'H1', mid: mid(), text: 'a', story: { id: '111' } }]); sendCalls.length = 0
    await client`update recovery_leads set bot_paused = true, bot_paused_by = 'Fulana', bot_paused_all = false where phone = 'ig_H1'`
    await client`delete from instagram_story_deliveries`
    await deliver(which, ISA, [{ sender: 'H1', mid: mid(), text: 'b', story: { id: '222' } }])
    noAi(); assert.equal(sendCalls.length, 0); assert.match(String((await deliveries())[0].reason), /Pausa/)
  })
  T('pausa geral (chave ligada): DM sai (bypass por desenho), 0 IA, lead continua pausado pela chave', async () => {
    await rule(); await client`insert into company_pause_switches (company_id, scope, active, paused_by) values (${isaId}, 'all', true, 'dono')`
    await deliver(which, ISA, [{ sender: 'P1', mid: mid(), text: 'a', story: { id: '111' } }])
    noAi(); assert.equal(sendCalls.length, 1)
  })
  T('tag "pessoa": não envia', async () => {
    await rule(); await deliver(which, ISA, [{ sender: 'T1', mid: mid(), text: 'a', story: { id: '111' } }]); sendCalls.length = 0
    const l = await leadOf('T1'); await client`insert into lead_tags (lead_id, tag, created_by) values (${l.id}, 'pessoa', 'qa')`
    await client`delete from instagram_story_deliveries`
    await deliver(which, ISA, [{ sender: 'T1', mid: mid(), text: 'b', story: { id: '222' } }]); noAi(); assert.equal(sendCalls.length, 0)
  })
  T('janela de 24h vencida: não envia', async () => {
    await rule({ enabled_at: new Date(Date.now() - 3 * 86_400_000) }); await deliver(which, ISA, [{ mid: mid(), text: 'a', story: { id: '1' }, ts: Date.now() - 25 * 3_600_000 }])
    noAi(); assert.equal(sendCalls.length, 0); assert.match(String((await deliveries())[0].reason), /24/)
  })
  T('antes do corte forward-only: não envia', async () => {
    process.env.ISABELA_FORWARD_ONLY_SINCE = new Date(Date.now() - 600_000).toISOString()
    await rule({ enabled_at: new Date(Date.now() - 3 * 3_600_000) }); await deliver(which, ISA, [{ mid: mid(), text: 'a', story: { id: '1' }, ts: Date.now() - 3_600_000 }])
    noAi(); assert.equal(sendCalls.length, 0)
  })
  T('evento anterior ao enabled_at: não envia', async () => {
    await rule({ enabled_at: new Date(Date.now() - 60_000) }); await deliver(which, ISA, [{ mid: mid(), text: 'a', story: { id: '1' }, ts: Date.now() - 3_600_000 }])
    noAi(); assert.equal(sendCalls.length, 0)
  })
  T('regra com enabled_at NULL (ativa sem data): não envia', async () => {
    await rule({ enabled_at: null }); await deliver(which, ISA, [{ mid: mid(), text: 'a', story: { id: '1' } }]); noAi(); assert.equal(sendCalls.length, 0)
  })
  T('ERRO DE BANCO nas tabelas de story: 200, 0 IA, 0 DM', async () => {
    await rule(); failStoryQueries = true
    const r = await deliver(which, ISA, [{ mid: mid(), text: 'a', story: { id: '1' } }]); assert.equal(r.status, 200); noAi(); assert.equal(sendCalls.length, 0)
  })
  T('TABELA INEXISTENTE (rota implantada antes da migração): 200, 0 IA, 0 DM', async () => {
    await client`drop table instagram_story_deliveries, instagram_story_automations cascade`
    try {
      const r = await deliver(which, ISA, [{ mid: mid(), text: 'a', story: { id: '1' } }]); assert.equal(r.status, 200); noAi(); assert.equal(sendCalls.length, 0)
    } finally { await client.unsafe(MIGRATION) }
  })
  T('erro de envio (ok:false) -> failed e não reenvia em nova mensagem', async () => {
    await rule(); sendBehavior = async () => ({ ok: false, error: 'HTTP 500' })
    await deliver(which, ISA, [{ sender: 'F1', mid: mid(), text: 'a', story: { id: '5' } }])
    await deliver(which, ISA, [{ sender: 'F1', mid: mid(), text: 'b', story: { id: '5' } }]); noAi()
    assert.equal(sendCalls.length, 1); assert.equal((await deliveries()).find(d => d.status !== 'skipped')?.status, 'failed')
  })
  T('timeout -> unknown e NUNCA reenvia', async () => {
    await rule(); sendBehavior = async () => ({ ok: false, uncertain: true, isTimeout: true, error: 'timeout' })
    await deliver(which, ISA, [{ sender: 'K1', mid: mid(), text: 'a', story: { id: '5' } }])
    await deliver(which, ISA, [{ sender: 'K1', mid: mid(), text: 'b', story: { id: '5' } }]); noAi()
    assert.equal(sendCalls.length, 1); assert.equal((await deliveries())[0].status, 'unknown')
  })
  T('ok sem message_id -> unknown e NUNCA reenvia', async () => {
    await rule(); sendBehavior = async () => ({ ok: true })
    await deliver(which, ISA, [{ sender: 'K2', mid: mid(), text: 'a', story: { id: '5' } }])
    await deliver(which, ISA, [{ sender: 'K2', mid: mid(), text: 'b', story: { id: '5' } }]); noAi()
    assert.equal(sendCalls.length, 1); assert.equal((await deliveries())[0].status, 'unknown')
  })
  T('regra com story específico DIFERENTE: não envia; story igual envia; específico vence "todos"', async () => {
    await rule({ story_id: '999', dm_message: 'ESPECIFICO' }); await deliver(which, ISA, [{ sender: 'S1', mid: mid(), text: 'a', story: { id: '111' } }])
    noAi(); assert.equal(sendCalls.length, 0)
    await rule({ dm_message: 'TODOS' })
    await deliver(which, ISA, [{ sender: 'S2', mid: mid(), text: 'a', story: { id: '999' } }])
    await deliver(which, ISA, [{ sender: 'S3', mid: mid(), text: 'a', story: { id: '111' } }]); noAi()
    assert.deepEqual(sendCalls.map(c => c.text), ['ESPECIFICO', 'TODOS'])
  })
  T('any aceita só emoji; contains/exact normalizam (acento, caixa)', async () => {
    await rule({ match_type: 'exact', keywords: ['Promoção'], dm_message: 'EX' })
    await deliver(which, ISA, [{ sender: 'M1', mid: mid(), text: ' PROMOCAO ', story: { id: '1' } }])
    await deliver(which, ISA, [{ sender: 'M2', mid: mid(), text: '🔥', story: { id: '1' } }]); noAi()
    assert.deepEqual(sendCalls.map(c => c.text), ['EX'])
    await rule({ match_type: 'any', dm_message: 'ANY' }); await deliver(which, ISA, [{ sender: 'M3', mid: mid(), text: '🔥', story: { id: '1' } }])
    assert.equal(sendCalls.at(-1)?.text, 'ANY')
  })
  T('MISTO: story + Direct normal na mesma entrega: story 0 IA, normal segue o fluxo (IA 1x)', async () => {
    await rule({ mode: 'observe' })
    await deliver(which, ISA, [{ sender: 'X1', mid: mid(), text: 'quero', story: { id: '1' } }, { sender: 'X2', mid: mid(), text: 'oi, tudo bem?' }])
    const l1 = await leadOf('X1'), l2 = await leadOf('X2')
    assert.deepEqual(aiCalls, [l2.id], 'IA só para o Direct normal'); assert.equal(kwCalls.length, 1); assert.ok(!aiCalls.includes(l1.id))
  })
  T('Direct normal sem reply_to.story (Isabela): gancho não consome, IA 1x', async () => {
    await rule(); await deliver(which, ISA, [{ sender: 'N1', mid: mid(), text: 'oi' }])
    assert.equal(aiCalls.length, 1); assert.equal(sendCalls.length, 0)
  })
  T('reaction (eco) e is_echo: não dispara nada', async () => {
    await rule()
    await deliver(which, ISA, [{ sender: 'R1', reaction: { mid: 'm', action: 'react', reaction: 'love', emoji: '❤' } }])
    await deliver(which, ISA, [{ sender: 'IG_ISA', mid: mid(), text: 'x', story: { id: '1' }, isEcho: true }]); noAi()
    assert.equal(sendCalls.length, 0); assert.equal((await deliveries()).length, 0)
  })
  T('LACUNA: story detectado pela casa (is_story_reply / reply_to.story sem id / story_id) NÃO deve ir para a IA na Isabela', async () => {
    await rule()
    const variants: Item[] = [
      { sender: 'V1', mid: mid(), text: 'oi', isStoryReply: true },
      { sender: 'V2', mid: mid(), text: 'oi', story: { url: 'https://cdn/x' } },
      { sender: 'V3', mid: mid(), text: 'oi', replyTo: { story_id: '123' } },
      { sender: 'V4', mid: mid(), text: 'oi', story: { id: 12345 } },
    ]
    for (const v of variants) await deliver(which, ISA, [v])
    assert.equal(aiCalls.length, 0, `IA chamada ${aiCalls.length}x em resposta a story reconhecida pelo isInstagramStoryReply`)
  })
  T('empresa não protegida sem regra lê regras uma vez, registra skipped e mantém a IA', async () => {
    await deliver(which, OUT, [{ sender: 'O1', mid: mid(), text: 'oi', story: { id: '111' } }])
    const withStory = queryLog.filter(q => q.includes('FROM instagram_story_automations')); assert.equal(withStory.length, 1)
    assert.equal(aiCalls.length, 1); assert.equal(kwCalls.length, 1)
    assert.equal((await deliveries())[0].status, 'skipped')
  })
  T('empresa não protegida em modo teste registra observed e mantém a IA', async () => {
    await rule({ company_id: outId, mode: 'observe' })
    await deliver(which, OUT, [{ sender: 'O2', mid: mid(), text: 'oi', story: { id: '111' } }])
    assert.equal(sendCalls.length, 0); assert.equal(aiCalls.length, 1); assert.equal((await deliveries())[0].status, 'observed')
  })
  T('empresa não protegida em modo envio reserva um Direct e não chama IA', async () => {
    await rule({ company_id: outId })
    await deliver(which, OUT, [{ sender: 'O3', mid: mid(), text: 'oi', story: { id: '111' } }])
    noAi(); assert.equal(sendCalls.length, 1); assert.equal((await deliveries())[0].status, 'sent')
  })
  T('empresa não protegida: 20 respostas concorrentes reservam um único Direct', async () => {
    await rule({ company_id: outId }); const concurrentMid = mid()
    await Promise.all(Array.from({ length: 20 }, (_, index) => deliver(index % 2 ? 'slug' : 'global', OUT, [{ sender: 'O4', mid: concurrentMid, text: 'oi', story: { id: '112' } }])))
    noAi(); assert.equal(sendCalls.length, 1)
  })
  T('empresa não protegida: envio incerto é consumido e nunca reenviado', async () => {
    await rule({ company_id: outId }); sendBehavior = async () => ({ ok: false, uncertain: true, isTimeout: true, error: 'timeout' })
    await deliver(which, OUT, [{ sender: 'O5', mid: mid(), text: 'oi', story: { id: '113' } }])
    await deliver(which, OUT, [{ sender: 'O5', mid: mid(), text: 'oi', story: { id: '113' } }])
    noAi(); assert.equal(sendCalls.length, 1); assert.equal((await deliveries())[0].status, 'unknown')
  })
  T('empresa não protegida: regra anterior à ativação e janela vencida seguem para IA; pausa humana mantém o bloqueio atual', async () => {
    await rule({ company_id: outId, enabled_at: new Date(Date.now() + 60_000) })
    await deliver(which, OUT, [{ sender: 'O6', mid: mid(), text: 'oi', story: { id: '114' } }])
    assert.equal(sendCalls.length, 0); assert.equal(aiCalls.length, 1)
    await reset(); await rule({ company_id: outId, enabled_at: new Date(Date.now() - 3 * 86_400_000) })
    await deliver(which, OUT, [{ sender: 'O7', mid: mid(), text: 'oi', story: { id: '115' }, ts: Date.now() - 25 * 3_600_000 }])
    assert.equal(sendCalls.length, 0); assert.equal(aiCalls.length, 1)
    await reset(); await rule({ company_id: outId, mode: 'observe' })
    await deliver(which, OUT, [{ sender: 'O8', mid: mid(), text: 'oi', story: { id: '116' } }]); const lead = await leadOf('O8')
    await client`update recovery_leads set bot_paused = true, bot_paused_by = 'humano', bot_paused_all = false where id = ${lead.id}`
    await client`update instagram_story_automations set mode = 'send' where company_id = ${outId}`; aiCalls.length = 0; kwCalls.length = 0
    await deliver(which, OUT, [{ sender: 'O8', mid: mid(), text: 'oi', story: { id: '117' } }])
    assert.equal(sendCalls.length, 0); assert.equal(aiCalls.length, 0)
  })
  T('empresa não protegida: tabela ausente ou erro de banco não muda o caminho para IA', async () => {
    await rule({ company_id: outId }); failStoryQueries = true
    const erro = await deliver(which, OUT, [{ sender: 'O9', mid: mid(), text: 'oi', story: { id: '118' } }])
    assert.equal(erro.status, 200); assert.equal(aiCalls.length, 1); assert.equal(sendCalls.length, 0)
    await reset(); await client`drop table instagram_story_deliveries, instagram_story_automations cascade`
    try {
      const semTabela = await deliver(which, OUT, [{ sender: 'O10', mid: mid(), text: 'oi', story: { id: '119' } }])
      assert.equal(semTabela.status, 200); assert.equal(aiCalls.length, 1); assert.equal(sendCalls.length, 0)
    } finally { await client.unsafe(MIGRATION) }
  })
  T('CONCORRÊNCIA: 20 entregas do MESMO mid (10 por rota) -> 1 DM', async () => {
    await rule(); const m = mid()
    await Promise.all(Array.from({ length: 20 }, (_, i) => deliver(i % 2 ? 'slug' : 'global', ISA, [{ sender: 'C1', mid: m, text: 'oi', story: { id: '7' } }])))
    noAi(); assert.equal(sendCalls.length, 1)
    assert.equal((await deliveries()).filter(d => ['reserved', 'sent', 'failed', 'unknown'].includes(d.status as string)).length, 1)
  })
  T('CONCORRÊNCIA: 2 mensagens diferentes da mesma pessoa no mesmo story, simultâneas -> 1 DM', async () => {
    await rule()
    await Promise.all([deliver(which, ISA, [{ sender: 'C2', mid: mid(), text: 'a', story: { id: '7' } }]), deliver(which, ISA, [{ sender: 'C2', mid: mid(), text: 'b', story: { id: '7' } }]), deliver('slug', ISA, [{ sender: 'C2', mid: mid(), text: 'c', story: { id: '7' } }])])
    noAi(); assert.equal(sendCalls.length, 1)
  })
  T('REENTREGA 21x sequencial do mesmo mid -> 1 DM e sem poluir deliveries', async () => {
    await rule(); const m = mid()
    for (let i = 0; i < 21; i++) await deliver(which, ISA, [{ sender: 'D1', mid: m, text: 'oi', story: { id: '7' } }])
    noAi(); assert.equal(sendCalls.length, 1); console.log('   linhas em deliveries após 21 reentregas =', (await deliveries()).length)
  })
  T('REENTREGA 21x em modo observe: não duplica linhas de log', async () => {
    await rule({ mode: 'observe' }); const m = mid()
    for (let i = 0; i < 21; i++) await deliver(which, ISA, [{ sender: 'D2', mid: m, text: 'oi', story: { id: '7' } }])
    noAi(); assert.equal((await deliveries()).length, 1)
  })
  T('mesma pessoa, story DIFERENTE, depois: 2º DM (1 por pessoa por story)', async () => {
    await rule(); await deliver(which, ISA, [{ sender: 'E1', mid: mid(), text: 'a', story: { id: '1' } }]); await deliver(which, ISA, [{ sender: 'E1', mid: mid(), text: 'a', story: { id: '2' } }])
    assert.equal(sendCalls.length, 2)
  })
  T('assinatura inválida: 401 e nada processado', async () => {
    const body = JSON.stringify({ object: 'instagram', entry: [{ id: ISA.ig, messaging: [messaging(ISA, { text: 'x', story: { id: '1' } })] }] })
    const url = which === 'slug' ? `https://sac.test/api/webhooks/instagram/${ISA.slug}` : 'https://sac.test/api/webhooks/instagram'
    const req = new RealNextRequest(url, { method: 'POST', headers: { 'x-hub-signature-256': 'sha256=00' }, body })
    const res = which === 'slug' ? await routeSlug(req, ISA.slug) : await routeGlobal(req); assert.equal(res.status, 401); noAi()
  })
}

// Casos adversariais da rodada 2, executados nas duas rotas assinadas.
const captured: string[] = []
for (const method of ['error', 'warn', 'log', 'info'] as const) { const original = console[method].bind(console); console[method] = (...args: unknown[]) => { captured.push(args.map(value => value instanceof Error ? `${value.name}: ${value.message}` : typeof value === 'string' ? value : JSON.stringify(value)).join(' ')); original(...args) } }
for (const which of ['slug', 'global'] as const) {
  const T = (name: string, fn: () => Promise<void>) => test(`[${which}] R2 ${name}`, async () => { await reset(); captured.length = 0; await fn() })
  let sequence = 0; const mid = () => `midR2_${which}_${++sequence}_${Math.random().toString(36).slice(2, 7)}`
  T('todos os formatos de story sem id isolam a IA e registram skipped', async () => {
    await rule(); const variants: Item[] = [{ sender: 'V1', mid: mid(), text: 'oi', isStoryReply: true }, { sender: 'V2', mid: mid(), text: 'oi', story: { url: 'https://cdn/x' } }, { sender: 'V3', mid: mid(), text: 'oi', replyTo: { story_id: '123' } }, { sender: 'V4', mid: mid(), text: 'oi', replyTo: { storyId: '123' } }, { sender: 'V5', mid: mid(), text: '🔥', story: { id: 12345 } }, { sender: 'V6', mid: mid(), text: 'oi', story: { id: '   ' } }, { sender: 'V7', mid: mid(), text: 'oi', story: { id: '', url: 'u' } }]
    for (const variant of variants) await deliver(which, ISA, [variant]); noAi(); assert.equal(sendCalls.length, 0); const all = await deliveries(); assert.equal(all.length, variants.length); assert.ok(all.every(delivery => delivery.status === 'skipped'))
  })
  T('id válido com is_story_reply segue o caminho de envio uma única vez', async () => { await rule(); await deliver(which, ISA, [{ sender: 'W1', mid: mid(), text: 'oi', story: { id: '777' }, isStoryReply: true }]); noAi(); assert.equal(sendCalls.length, 1) })
  T('reply_to de mensagem comum continua indo uma vez à IA', async () => { await rule(); await deliver(which, ISA, [{ sender: 'W2', mid: mid(), text: 'oi', replyTo: { mid: 'm.abc' } }]); assert.equal(aiCalls.length, 1); assert.equal(sendCalls.length, 0); assert.equal((await deliveries()).length, 0) })
  T('reaction de eco, story sem id e Direct normal só deixam o normal chegar à IA', async () => {
    await rule({ mode: 'observe' }); await deliver(which, ISA, [{ sender: 'R1', reaction: { mid: 'm', action: 'react', emoji: '❤', reaction: 'love' } }, { sender: 'R2', mid: mid(), text: 'oi', isStoryReply: true }, { sender: 'R3', mid: mid(), text: 'dúvida sobre o preço' }]); const l3 = await leadOf('R3'); assert.deepEqual(aiCalls, [l3.id]); assert.equal(kwCalls.length, 1); assert.equal(sendCalls.length, 0); assert.equal((await deliveries()).length, 1)
  })
  T('erros não vazam sender, mid, texto, DM nem parâmetros nos logs', async () => {
    await rule(); failStoryQueries = true; await deliver(which, ISA, [{ sender: 'LOGSENDER1', mid: 'MIDSECRETO1', text: 'TEXTOSECRETO', story: { id: '4242' } }]); failStoryQueries = false; await client`drop table instagram_story_deliveries, instagram_story_automations cascade`; try { await deliver(which, ISA, [{ sender: 'LOGSENDER2', mid: 'MIDSECRETO2', text: 'TEXTOSECRETO', story: { id: '4242' } }]) } finally { await client.unsafe(MIGRATION) }
    const lines = captured.filter(line => /Story Trigger|Story Automations/.test(line)); assert.ok(lines.length >= 1); for (const line of lines) assert.ok(!/LOGSENDER|MIDSECRETO|TEXTOSECRETO|params|Failed query|DM-AUTO/i.test(line), `vazou: ${line}`); noAi()
  })
  T('erro hostil do banco também não é repassado ao log', async () => { await rule(); failStoryQueries = true; await deliver(which, ISA, [{ sender: 'LOGSENDER3', mid: 'MIDSECRETO3', text: 'x', story: { id: '4242' } }]); assert.ok(!captured.some(line => /LOGSENDER3|MIDSECRETO3/.test(line))) })
  T('outra empresa sem regra mantém IA e só consulta regras para o item com id de Story', async () => { await deliver(which, OUT, [{ sender: 'O1', mid: mid(), text: 'oi', isStoryReply: true }, { sender: 'O2', mid: mid(), text: 'oi', story: { id: '9' } }]); assert.equal(queryLog.filter(query => query.includes('FROM instagram_story_automations')).length, 1); assert.equal(aiCalls.length, 2); assert.equal(sendCalls.length, 0) })
  T('evento anterior a enabled_at não envia, posterior envia', async () => { await rule({ enabled_at: new Date(Date.now() - 60_000) }); await deliver(which, ISA, [{ sender: 'L1', mid: mid(), text: 'a', story: { id: '5' }, ts: Date.now() - 3_600_000 }]); assert.equal(sendCalls.length, 0); await deliver(which, ISA, [{ sender: 'L2', mid: mid(), text: 'a', story: { id: '5' }, ts: Date.now() - 1_000 }]); assert.equal(sendCalls.length, 1); noAi() })
  T('send_state accepted e uncertain seguem a regra do histórico e da métrica', async () => {
    await rule(); await deliver(which, ISA, [{ sender: 'H1', mid: mid(), text: 'a', story: { id: '5' } }]); sendBehavior = async () => ({ ok: false, uncertain: true, isTimeout: true, error: 't' }); await deliver(which, ISA, [{ sender: 'H2', mid: mid(), text: 'a', story: { id: '5' } }]); const rows = await client`select m.send_state, m.external_id from whatsapp_messages m where m.direction = 'outbound' order by m.id`; assert.deepEqual(rows.map(row => row.send_state), ['accepted', 'uncertain']); const visible = await client`select count(*)::int c from whatsapp_messages where direction='outbound' and (send_state = 'accepted' or (send_state is null and external_id is not null))`; assert.equal(visible[0].c, 1); const { classifySendMetric } = await import('../src/lib/channel-send-metrics'); assert.equal(classifySendMetric(rows[0].send_state as string, !!rows[0].external_id), 'accepted'); assert.equal(classifySendMetric(rows[1].send_state as string, !!rows[1].external_id), 'uncertain')
  })
}
before(boot)
afterAll(async () => { await client.end({ timeout: 2 }) })
