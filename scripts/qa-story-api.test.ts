// QA adversarial das rotas /api/story-automations (+[id], logs, stories). Postgres descartável real.
// Uso: QA_PG_URL=postgres://postgres:test@127.0.0.1:55432/test node --experimental-test-module-mocks --import tsx --test scripts/qa-story-api.test.ts
// Sem QA_PG_URL sai limpo: o schema e os mocks desta rota ainda exigem Postgres completo, não PGlite.
import { test, mock, before, after as afterAll } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { PgDialect } from 'drizzle-orm/pg-core'
import * as schema from '../src/lib/db/schema'
import { NextRequest } from 'next/server'

const URL_PG = process.env.QA_PG_URL
if (!URL_PG) { console.log('SKIP qa-story-api: defina QA_PG_URL para executar contra Postgres descartável.'); process.exit(0) }
const MIGRATION = readFileSync(path.resolve(__dirname, '../drizzle/0045_instagram_story_trigger.sql'), 'utf8')
const client = postgres(URL_PG, { max: 5, onnotice: () => {} })
const rawDb = drizzle(client, { schema })
const dialect = new PgDialect()
const db = new Proxy(rawDb, { get(t, p) {
  if (p === 'execute') return async (q: never) => { const b = dialect.sqlToQuery(q); return Array.from(await client.unsafe(b.sql, b.params.map(x => (x instanceof Date ? x.toISOString() : x)) as never) as unknown as unknown[]) }
  const v = Reflect.get(t, p); return typeof v === 'function' ? v.bind(t) : v } })

class AuthError extends Error { readonly status = 401 }
class ForbiddenError extends Error { readonly status = 403 }
let session: { companyId: number; role: 'admin' | 'membro' | null } = { companyId: 0, role: 'admin' }
mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/auth', { namedExports: {
  AuthError, ForbiddenError,
  forbiddenResponse: () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
  requireCompany: async () => { if (session.role === null) throw new AuthError('x'); return { id: session.companyId, slug: session.companyId === A ? 'isabela-fanini' : 'b' } },
  requireCompanyRole: async () => { if (session.role === null) throw new AuthError('x'); if (session.role !== 'admin') throw new ForbiddenError(); return { company: { id: session.companyId, slug: session.companyId === A ? 'isabela-fanini' : 'b' } } },
} })

let A = 0, B = 0
let R: typeof import('../src/app/api/story-automations/route'), RI: typeof import('../src/app/api/story-automations/[id]/route'), RL: typeof import('../src/app/api/story-automations/logs/route'), RS: typeof import('../src/app/api/story-automations/stories/route')
const req = (method: string, body?: unknown, url = 'https://sac.test/api/story-automations') => new NextRequest(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const ctx = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) })
const seed = async (companyId: number, over: Record<string, unknown> = {}) => { const v = { name: 'seed', keywords: ['p'], mt: 'contains', active: false, mode: 'observe', ...over }; const [r] = await client`insert into instagram_story_automations (company_id,name,keywords,match_type,dm_message,mode,is_active,enabled_at) values (${companyId},${v.name as string},${client.array(v.keywords as string[])},${v.mt as string},'oi',${v.mode as string},${v.active as boolean},${v.active ? new Date().toISOString() : null}::timestamptz) returning id`; return r.id as number }
const good = { name: 'r', keywords: ['quero'], matchType: 'contains', dmMessage: 'oi', mode: 'observe', isActive: false }

before(async () => {
  await client`drop table if exists instagram_story_deliveries, instagram_story_automations cascade`
  await client.unsafe(MIGRATION)
  await client`truncate companies restart identity cascade`
  const [a] = await client`insert into companies (name, slug) values ('A','isabela-fanini') returning id`; const [b] = await client`insert into companies (name, slug) values ('B','b') returning id`
  A = a.id; B = b.id
  await client`insert into settings (company_id, instagram_account_id, instagram_access_token) values (${A}, 'ACC_A', 'TOKEN_SECRETO_A')`
  await client`insert into settings (company_id, instagram_account_id, instagram_access_token) values (${B}, 'ACC_B', 'TOKEN_SECRETO_B')`
  R = await import('../src/app/api/story-automations/route'); RI = await import('../src/app/api/story-automations/[id]/route'); RL = await import('../src/app/api/story-automations/logs/route'); RS = await import('../src/app/api/story-automations/stories/route')
})
afterAll(async () => { await client.end({ timeout: 2 }) })
const as = (companyId: number, role: 'admin' | 'membro' | null = 'admin') => { session = { companyId, role } }

test('POST contains com 1 palavra', async () => { as(A); const r = await R.POST(req('POST', good)); const j = await r.json(); assert.equal(r.status, 201, JSON.stringify(j)) })
test('POST contains com 3 palavras (array vira ROW no drizzle sql?)', async () => { as(A); const r = await R.POST(req('POST', { ...good, keywords: ['a', 'b', 'c'] })); const j = await r.json(); assert.equal(r.status, 201, JSON.stringify(j)); assert.deepEqual(j.automation.keywords, ['a', 'b', 'c']) })
test('POST any com keywords [] ("Qualquer resposta")', async () => { as(A); const r = await R.POST(req('POST', { ...good, matchType: 'any', keywords: [] })); const j = await r.json(); assert.equal(r.status, 201, JSON.stringify(j)) })
test('POST escapa array do Postgres com aspas, vírgula, chaves, barras e acento', async () => {
  as(A); const words = ['a"b', 'ç;d', '{chave}', 'c\\d']; const r = await R.POST(req('POST', { ...good, keywords: words })); const j = await r.json()
  assert.equal(r.status, 201, JSON.stringify(j)); assert.deepEqual(j.automation.keywords, words)
})
test('POST ignora company_id/companyId/enabledAt do corpo; enabled_at só do servidor', async () => {
  as(A); const r = await R.POST(req('POST', { ...good, keywords: ['x'], isActive: true, companyId: B, company_id: B, enabledAt: '2000-01-01T00:00:00Z', enabled_at: '2000-01-01T00:00:00Z' }))
  const j = await r.json(); assert.equal(r.status, 201, JSON.stringify(j)); assert.equal(j.automation.companyId, A)
  assert.ok(Date.now() - new Date(j.automation.enabledAt).getTime() < 10_000, 'enabled_at tem que ser do servidor')
})
test('validações: dm 1001 bytes, emoji bytes, storyId, palavras vazias, tipo/modo inválido', async () => {
  as(A)
  assert.equal((await R.POST(req('POST', { ...good, dmMessage: 'a'.repeat(1001) }))).status, 400)
  assert.equal((await R.POST(req('POST', { ...good, dmMessage: '😀'.repeat(251) }))).status, 400, '251 emojis = 1004 bytes')
  assert.equal((await R.POST(req('POST', { ...good, storyId: 'abc' }))).status, 400)
  assert.equal((await R.POST(req('POST', { ...good, keywords: [] }))).status, 400)
  assert.equal((await R.POST(req('POST', { ...good, keywords: ['  ', ''] }))).status, 400)
  assert.equal((await R.POST(req('POST', { ...good, matchType: 'regex' }))).status, 400)
  assert.equal((await R.POST(req('POST', { ...good, mode: 'x' }))).status, 400)
  assert.equal((await R.POST(req('POST', { ...good, name: '   ' }))).status, 400)
  assert.equal((await R.POST(req('POST', '[]' as never))).status, 400)
})
test('auth: sem sessão 401; membro 403; GET lista só da empresa', async () => {
  as(A, null); assert.equal((await R.GET()).status, 401); assert.equal((await R.POST(req('POST', good))).status, 401)
  as(A, 'membro'); assert.equal((await R.GET()).status, 403); assert.equal((await R.POST(req('POST', good))).status, 403)
  await seed(A); await seed(B, { name: 'DA-B' }); as(B); const j = await (await R.GET()).json()
  assert.ok(j.automations.every((x: { companyId: number }) => x.companyId === B))
})
test('conta fora do piloto não consegue ler, alterar ou excluir regra', async () => {
  const id = await seed(A, { name: 'alvo-A' })
  as(B)
  assert.equal((await RI.GET(req('GET'), ctx(id))).status, 403)
  assert.equal((await RI.PATCH(req('PATCH', { name: 'HACK', isActive: true }), ctx(id))).status, 403)
  assert.equal((await RI.DELETE(req('DELETE'), ctx(id))).status, 403)
  const [row] = await client`select name, is_active from instagram_story_automations where id = ${id}`; assert.notEqual(row.name, 'HACK')
  as(A); assert.equal((await RI.GET(req('GET'), ctx('abc'))).status, 400); assert.equal((await RI.GET(req('GET'), ctx('-1'))).status, 400)
})
test('PATCH: ativar e observe->send renovam enabled_at; story "" grava NULL', async () => {
  as(A); const id = await seed(A, { keywords: ['p'] })
  const tog = await RI.PATCH(req('PATCH', { isActive: true }), ctx(id)); assert.equal(tog.status, 200, 'botão Ativar/Desativar (PATCH só com isActive): ' + JSON.stringify(await tog.clone().json()))
    await client`update instagram_story_automations set enabled_at = now() - interval '3 days' where id = ${id}`
  const sw = await (await RI.PATCH(req('PATCH', { mode: 'send' }), ctx(id))).json()
  assert.ok(Date.now() - new Date(sw.automation.enabledAt).getTime() < 10_000, 'observe->send deve iniciar novo corte forward-only')
  const st = await (await RI.PATCH(req('PATCH', { storyId: '' }), ctx(id))).json(); console.log('   PATCH storyId "" grava =', JSON.stringify(st.automation.storyId))
  assert.ok(st.automation.storyId === null, 'storyId "" deve virar NULL (todos os stories)')
  const kw = await RI.PATCH(req('PATCH', { keywords: ['x', 'y'] }), ctx(id)); assert.equal(kw.status, 200, JSON.stringify(await kw.json()))
  const bad = await RI.PATCH(req('PATCH', { matchType: 'exact', keywords: [] }), ctx(id)); assert.equal(bad.status, 400)
  const any = await RI.PATCH(req('PATCH', { matchType: 'any', keywords: [] }), ctx(id)); assert.equal(any.status, 200, JSON.stringify(await any.json()))
})
test('conta fora do piloto não lista, cria nem altera regra', async () => {
  as(B); const list = await (await R.GET()).json(); assert.equal(list.enabled, false); assert.equal(list.automations.length, 0)
  assert.equal((await R.POST(req('POST', good))).status, 403)
  assert.equal((await RI.PATCH(req('PATCH', { isActive: true }), ctx(1))).status, 403)
})
test('logs: só da própria empresa mesmo com automationId alheio', async () => {
  as(A); const [{ id: autoA }] = await client`select id from instagram_story_automations where company_id = ${A} limit 1`
  await client`insert into instagram_story_deliveries (company_id, automation_id, sender_id, story_id, occurred_at, status) values (${A}, ${autoA}, 's', '1', now(), 'observed')`
  as(B); assert.equal((await RL.GET(req('GET', undefined, `https://sac.test/api/story-automations/logs?automationId=${autoA}`) as never)).status, 403)
  as(A); assert.equal((await (await RL.GET(req('GET', undefined, 'https://sac.test/x') as never)).json()).logs.length, 1)
})

// ---- stories ----
const realFetch = globalThis.fetch
test('stories: sem token -> erro limpo em português; token nunca na resposta', async () => {
  await client`update settings set instagram_access_token = null where company_id = ${A}`
  as(A); const r = await RS.GET(); const t = await r.text(); assert.equal(r.status, 400); assert.match(t, /não estão configurados|não configurad/); await client`update settings set instagram_access_token = 'TOKEN_SECRETO_A' where company_id = ${A}`
})
test('stories: só a conta da empresa, token só no header; falhas 401/429/timeout/rede limpas', async () => {
  const seen: Array<{ url: string; auth: string | null }> = []
  const logs: string[] = []; const origErr = console.error; console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')) }
  try {
    globalThis.fetch = (async (u: URL | string, init?: RequestInit) => { seen.push({ url: String(u), auth: new Headers(init?.headers).get('authorization') }); return new Response(JSON.stringify({ data: [{ id: '17900000000000001', media_type: 'IMAGE', timestamp: '2026-11-13T10:00:00+0000' }, { nope: 1 }] }), { status: 200 }) }) as never
    as(A); const ok = await RS.GET(); const j = await ok.json(); assert.equal(ok.status, 200); assert.equal(j.stories.length, 1)
    assert.ok(seen[0].url.includes('/ACC_A/stories') && !seen[0].url.includes('ACC_B')); assert.equal(seen[0].auth, 'Bearer TOKEN_SECRETO_A'); assert.ok(!seen[0].url.includes('TOKEN'))
    for (const [status, body] of [[401, { error: { message: 'Invalid OAuth access token - Cannot parse access token', code: 190 } }], [429, { error: { message: 'Application request limit reached' } }], [500, {}]] as const) {
      globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as never
      const r = await RS.GET(); const t = await r.text(); console.log(`   Graph ${status} -> HTTP ${r.status} ${t}`)
      assert.ok(!t.includes('TOKEN_SECRETO'))
    }
    globalThis.fetch = (async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) }) as never
    const r = await RS.GET(); const t = await r.text(); console.log('   timeout ->', r.status, t); assert.ok(!t.includes('TOKEN_SECRETO'))
    globalThis.fetch = (async () => new Response('<html>bad gateway</html>', { status: 502 })) as never
    const r2 = await RS.GET(); console.log('   502 html ->', r2.status, await r2.text())
    assert.ok(!logs.join('\n').includes('TOKEN_SECRETO'), 'token apareceu em log')
    as(A, null); assert.equal((await RS.GET()).status, 401)
  } finally { globalThis.fetch = realFetch; console.error = origErr }
})

// Casos adversariais da rodada 2, mantidos junto à suíte permanente.
const MATRIX: string[][] = [[], ['a'], ['a', 'b', 'c'], ['a"b'], ['{chave}'], ['c\\d'], ['\\'], ['"'], ["x'y"], ['NULL'], ['$1'], ['ação', 'ÇÃO'], ['a b'], ['😀'], ['}{'], ['\\"'], ['{"a";"b"}'], ['\\\\"'], ['x'.repeat(120)], ['--'], ['a;DROP TABLE companies;--'], ["'); DROP TABLE x;--"]]
test('B1 matriz POST: round-trip exato (ida e volta pelo Postgres)', async () => {
  as(A)
  for (const kw of MATRIX) {
    const r = await R.POST(req('POST', { ...good, matchType: kw.length ? 'contains' : 'any', keywords: kw })); const j = await r.json()
    assert.equal(r.status, 201, JSON.stringify(kw) + ' ' + JSON.stringify(j)); assert.deepEqual(j.automation.keywords, kw)
    const [row] = await client`select keywords from instagram_story_automations where id = ${j.automation.id}`; assert.deepEqual(row.keywords, kw)
  }
  const t = await client`select count(*)::int c from information_schema.tables where table_name in ('companies','x')`; assert.equal(t[0].c, 1)
})
test('B1 matriz PATCH e ativar/desativar preservam as palavras', async () => {
  as(A)
  for (const kw of MATRIX) {
    const id = await seed(A, { keywords: ['orig'] }); const r = await RI.PATCH(req('PATCH', kw.length ? { keywords: kw } : { matchType: 'any', keywords: [] }), ctx(id)); const j = await r.json()
    assert.equal(r.status, 200, JSON.stringify(j)); assert.deepEqual(j.automation.keywords, kw)
    const on = await RI.PATCH(req('PATCH', { isActive: true }), ctx(id)); assert.equal(on.status, 200); assert.deepEqual((await on.json()).automation.keywords, kw)
    assert.equal((await RI.PATCH(req('PATCH', { isActive: false }), ctx(id))).status, 200)
  }
})
test('B1: palavras vazias são recusadas e any aceita lista vazia', async () => {
  as(A); assert.equal((await R.POST(req('POST', { ...good, keywords: [' '] }))).status, 400)
  const id = await seed(A); assert.equal((await RI.PATCH(req('PATCH', { keywords: [], matchType: 'exact' }), ctx(id))).status, 400)
  assert.equal((await RI.PATCH(req('PATCH', { keywords: [] }), ctx(id))).status, 400)
  assert.equal((await RI.PATCH(req('PATCH', { matchType: 'any', keywords: [] }), ctx(id))).status, 200)
})
test('R2-2: palavra com vírgula é recusada no POST e no PATCH', async () => {
  as(A); assert.equal((await R.POST(req('POST', { ...good, keywords: ['ç,d'] }))).status, 400)
  const id = await seed(A); assert.equal((await RI.PATCH(req('PATCH', { keywords: ['ç,d'] }), ctx(id))).status, 400)
})
test('M5: enabled_at renova só nas mudanças que reativam o gatilho', async () => {
  as(A); const old = async (id: number) => { await client`update instagram_story_automations set enabled_at = now() - interval '3 days' where id = ${id}` }; const age = async (id: number) => (await client`select extract(epoch from (now() - enabled_at))::float as s from instagram_story_automations where id = ${id}`)[0].s as number
  let id = await seed(A, { active: false }); await RI.PATCH(req('PATCH', { isActive: true }), ctx(id)); assert.ok((await age(id)) < 10)
  id = await seed(A, { active: true, mode: 'observe' }); await old(id); await RI.PATCH(req('PATCH', { mode: 'send' }), ctx(id)); assert.ok((await age(id)) < 10)
  for (const patch of [{ keywords: ['novo'] }, { matchType: 'exact' }, { storyId: '123' }, { dmMessage: 'outra' }]) { id = await seed(A, { active: true, mode: 'send' }); await old(id); await RI.PATCH(req('PATCH', patch), ctx(id)); assert.ok((await age(id)) < 10) }
  id = await seed(A, { active: true, mode: 'send' }); await old(id); await RI.PATCH(req('PATCH', { name: 'só o nome' }), ctx(id)); assert.ok((await age(id)) > 86400)
  id = await seed(A, { active: true, mode: 'send' }); await old(id); await RI.PATCH(req('PATCH', { isActive: false }), ctx(id)); assert.ok((await age(id)) > 86400)
})
test('M4: conta fora do piloto não consulta nem acessa as rotas de story', async () => {
  as(B); assert.deepEqual(await (await R.GET()).json(), { enabled: false, automations: [] }); assert.equal((await R.POST(req('POST', good))).status, 403)
  assert.equal((await RI.PATCH(req('PATCH', { isActive: true }), ctx(1))).status, 403); assert.equal((await RI.DELETE(req('DELETE'), ctx(1))).status, 403); assert.equal((await RI.GET(req('GET'), ctx(1))).status, 403)
  assert.equal((await RL.GET(req('GET', undefined, 'https://sac.test/x') as never)).status, 403); assert.equal((await RS.GET()).status, 403)
})
test('B-baixos: IDs e storyId inválidos retornam 400; espaço em storyId vira NULL', async () => {
  as(A); for (const id of ['1e3', '0x10', '+1', '0', '01', ' 1', '1.0', '-1', 'abc']) assert.equal((await RI.GET(req('GET'), ctx(id))).status, 400)
  const id = await seed(A); assert.equal((await RI.PATCH(req('PATCH', { storyId: '12ab' }), ctx(id))).status, 400); assert.equal((await (await RI.PATCH(req('PATCH', { storyId: '   ' }), ctx(id))).json()).automation.storyId, null)
})
test('stories: erros Graph e timeout retornam 502 sem vazar token', async () => {
  const real = globalThis.fetch
  try { for (const [status, body] of [[401, { error: { message: 'Invalid OAuth', code: 190 } }], [429, {}], [500, {}]] as const) { globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as never; as(A); const r = await RS.GET(); const t = await r.text(); assert.equal(r.status, 502); assert.ok(!/Invalid OAuth|TOKEN_SECRETO/.test(t)) }; globalThis.fetch = (async () => { throw new Error('timeout') }) as never; assert.equal((await RS.GET()).status, 502) } finally { globalThis.fetch = real }
})
