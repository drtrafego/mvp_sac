// Postgres descartável com schema real aplicado via drizzle-kit push.
// QA_PG_URL=... node --experimental-test-module-mocks --import tsx --test scripts/instagram-automation-reporting.test.ts
import { test, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'
import { NextRequest } from 'next/server'

if (!process.env.QA_PG_URL) throw new Error('Defina QA_PG_URL para um Postgres descartável com o schema do projeto.')
const client = postgres(process.env.QA_PG_URL, { max: 1, onnotice: () => {} })
const rawDb = drizzle(client, { schema })
const dialect = new PgDialect()
let objectResults = false
const db = new Proxy(rawDb, { get(target, property) {
  if (property === 'execute') return async (query: SQL) => {
    const compiled = dialect.sqlToQuery(query)
    const result = Array.from(await client.unsafe(compiled.sql, compiled.params as never[]))
    return objectResults ? { rows: result } : result
  }
  const value = Reflect.get(target, property)
  return typeof value === 'function' ? value.bind(target) : value
} })
mock.module('@/lib/db', { namedExports: { db } })
// A autenticação de agente NÃO é simulada. Só a sessão visual é isolada.
mock.module('@/lib/auth', { namedExports: { getCurrentUser: async () => null, getCurrentCompany: async () => null } })
for (const name of ['SAC_API_KEY', 'SAC_AGENT_BIA_KEY', 'SAC_AGENT_LUANA_KEY', 'SAC_AGENT_RENATO_KEY', 'SAC_AGENT_FLAVIO_OTONI_KEY']) delete process.env[name]

let metricsRoute: typeof import('../src/app/api/v1/companies/[idOrSlug]/instagram-automations/metrics/route')
let logsRoute: typeof import('../src/app/api/v1/companies/[idOrSlug]/instagram-automations/[type]/[id]/logs/route')
const period = 'from=2026-01-01&to=2026-01-02'
const commentStatuses = ['sent', 'failed', 'skipped', 'rate_limited', 'ignorado_pausa', 'observed', 'processing', 'reserved', 'future_status']
const storyStatuses = ['sent', 'failed', 'skipped', 'observed', 'reserved', 'unknown']
const sender = '17841400123456789'
const secretText = 'conteúdo privado contato@exemplo.test token=segredo ' + 'x'.repeat(500)
const request = (url: string, key: string | null = 'key-a', bearer = false) => new NextRequest(`https://sac.test${url}`, {
  headers: key ? bearer ? { authorization: `Bearer ${key}` } : { 'x-api-key': key } : {},
})
async function metrics(query = period, company = 'empresa-a', key: string | null = 'key-a', bearer = false) {
  return metricsRoute.GET(request(`/api/v1/companies/${company}/instagram-automations/metrics?${query}`, key, bearer), { params: Promise.resolve({ idOrSlug: company }) })
}
async function logs(type = 'comment', id = '101', query = period, company = 'empresa-a', key: string | null = 'key-a') {
  return logsRoute.GET(request(`/api/v1/companies/${company}/instagram-automations/${type}/${id}/logs?${query}`, key), { params: Promise.resolve({ idOrSlug: company, type, id }) })
}

before(async () => {
  await client.unsafe(readFileSync(new URL('../drizzle/0045_instagram_story_trigger.sql', import.meta.url), 'utf8'))
  await client`truncate companies restart identity cascade`
  await client`insert into companies (id, name, slug) values (1,'A','empresa-a'),(2,'B','empresa-b'),(3,'Vazia','vazia'),(25394,'Restrita','flavio-otoni')`
  await client`insert into settings (company_id, agent_bia_api_key) values (1,'key-a'),(2,'key-b'),(3,'key-empty')`
  for (const companyId of [1, 2]) {
    for (const index of [1, 2]) {
      const id = companyId * 100 + index
      await client`insert into instagram_comment_automations (id,company_id,name,keywords,match_type,trigger_type,media_id,dm_message,is_active) values (${id},${companyId},${`Comentário ${id}`},'QUERO, PREÇO','contains','both',${index === 1 ? 'media-teste' : null},'SEGREDO DM',true)`
      await client`insert into instagram_story_automations (id,company_id,name,keywords,match_type,story_id,dm_message,mode,is_active) values (${id},${companyId},${`Story ${id}`},ARRAY['QUERO','PREÇO'],'exact','story-teste','SEGREDO DM','observe',false)`
    }
  }
  for (const [i, status] of commentStatuses.entries()) {
    await client`insert into instagram_comment_logs (id,company_id,automation_id,comment_id,commenter_id,commenter_username,comment_text,matched_keyword,status,error_message,created_at,sent_at)
      values (${100 + i},1,101,${`c-${i}`},${sender + i},'conta_teste',${secretText},'QUERO',${status},${secretText},${i === 0 ? '2026-01-01T00:00:00Z' : '2026-01-02T00:00:00Z'},'2026-02-01')`
  }
  for (const [i, status] of storyStatuses.entries()) {
    await client`insert into instagram_story_deliveries (id,company_id,automation_id,sender_id,story_id,status,reason,outbound_message_id,occurred_at,created_at)
      values (${200 + i},1,101,${sender + i},'story-teste',${status},${status === 'skipped' ? 'Resposta anterior à ativação da regra.' : secretText},${status === 'sent' ? 'mid-teste' : null},'2025-12-01','2026-01-01T12:00:00Z')`
  }
  // Registros fora do período, sem regra e com associação cruzada inconsistente.
  for (const [id, companyId, automationId, date] of [[300,1,101,'2025-12-31T23:59:59.999Z'],[301,1,101,'2026-01-02T00:00:00.001Z'],[302,2,101,'2026-01-01'],[303,2,201,'2026-01-01']] as const) {
    await client`insert into instagram_comment_logs (id,company_id,automation_id,comment_id,commenter_id,status,created_at) values (${id},${companyId},${automationId},${`c-${id}`},${sender + id},'sent',${date})`
    await client`insert into instagram_story_deliveries (id,company_id,automation_id,sender_id,story_id,status,occurred_at,created_at) values (${id},${companyId},${automationId},${sender + id},'story-teste','sent',${date},${date})`
  }
  await client`insert into instagram_comment_logs (company_id,comment_id,commenter_id,status,created_at) values (1,'orphan','manual:123','skipped','2026-01-01')`
  await client`insert into instagram_story_deliveries (company_id,sender_id,story_id,status,occurred_at,created_at) values (1,'1234','story-teste','observed','2026-01-01','2026-01-01')`
  // Qualquer escrita nas requisições abaixo falha no próprio Postgres.
  await client`set default_transaction_read_only = on`
  await client`set timezone = 'America/Sao_Paulo'`
  metricsRoute = await import('../src/app/api/v1/companies/[idOrSlug]/instagram-automations/metrics/route')
  logsRoute = await import('../src/app/api/v1/companies/[idOrSlug]/instagram-automations/[type]/[id]/logs/route')
})
after(async () => { await client.end({ timeout: 2 }) })

test('métricas misturadas, todos os status, regras sem logs e totais sem regra', async () => {
  const response = await metrics()
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(body.automations.map((r: { type: string; id: number }) => [r.type, r.id]), [['comment',101],['comment',102],['story',101],['story',102]])
  const c = body.automations[0]
  assert.deepEqual(c.keywords, ['QUERO', 'PREÇO'])
  assert.equal(c.triggerType, 'both'); assert.equal(c.targetId, 'media-teste'); assert.equal(c.isActive, true)
  assert.deepEqual(c.totais, { disparos:9, enviados:1, falhas:1, ignorados:3, observados:1, reservados:2, desconhecidos:1, ultimoDisparo:'2026-01-02T00:00:00.000Z', visualizou:null, clicou:null, disponivel:{ visualizou:false, clicou:false } })
  const s = body.automations[2]
  assert.deepEqual(s.keywords, ['QUERO','PREÇO']); assert.equal(s.mode, 'observe'); assert.equal(s.isActive, false)
  assert.equal(s.triggerType, 'story_reply'); assert.equal(s.targetId, 'story-teste')
  assert.deepEqual(s.totais, { ...c.totais, disparos:6, ignorados:1, reservados:1, ultimoDisparo:'2026-01-01T12:00:00.000Z' })
  for (const index of [1, 3]) {
    assert.equal(body.automations[index].totais.disparos, 0)
    assert.equal(body.automations[index].totais.ultimoDisparo, null)
  }
  assert.equal(body.porTipo.comment.disparos, 10); assert.equal(body.porTipo.story.disparos, 7)
  assert.equal(body.totais.disparos,17); assert.equal(body.totais.enviados,2); assert.equal(body.totais.falhas,2)
  assert.equal(body.totais.visualizou,null); assert.equal(body.totais.clicou,null)
  assert.deepEqual(body.totais.disponivel,{visualizou:false,clicou:false})
  assert.ok(!JSON.stringify(body).includes('SEGREDO'))
})

test('filtros por tipo, período inclusivo e formato rows do driver Neon', async () => {
  for (const type of ['comment','story']) {
    objectResults = true
    try {
      const body = await (await metrics(`${period}&type=${type}`)).json()
      assert.equal(body.automations.length,2)
      assert.ok(body.automations.every((r: { type: string }) => r.type === type))
      assert.equal(body.totais.disparos,type === 'comment' ? 10 : 7)
      assert.equal(body.porTipo[type === 'comment' ? 'story' : 'comment'].disparos,0)
    } finally { objectResults = false }
  }
  const body = await (await metrics('from=2026-01-01T00:00:00Z&to=2026-01-01T00:00:00Z')).json()
  assert.equal(body.automations[0].totais.disparos,1)
  assert.equal(body.automations[2].totais.disparos,0)
  const empty = await (await metrics('from=2026-03-01&to=2026-03-02')).json()
  assert.equal(empty.totais.disparos,0)
})

test('logs: status normalizado, máscara, UTC e nenhum conteúdo/erro bruto', async () => {
  for (const type of ['comment', 'story']) {
    const response = await logs(type)
    const body = await response.json()
    assert.equal(response.status,200,JSON.stringify(body))
    assert.equal(body.total,type === 'comment' ? 9 : 6)
    const text = JSON.stringify(body)
    assert.ok(!text.includes(sender)); assert.ok(!text.includes('contato@')); assert.ok(!text.includes('segredo'))
    const statuses = type === 'comment' ? ['unknown','reserved','reserved','observed','skipped','skipped','skipped','failed','sent'] : [...storyStatuses].reverse()
    assert.deepEqual(body.logs.map((l: {status:string})=>l.status),statuses)
    for (const entry of body.logs) {
      assert.match(entry.senderId,/^\*{4}\d{4}$/)
      assert.ok(entry.createdAt.endsWith('Z'))
      assert.ok(entry.reason === null || entry.reason.length <= 200)
      assert.equal(entry.commentText,undefined)
      if (type === 'story' && entry.status === 'skipped') assert.equal(entry.reason,'Resposta anterior à ativação da regra.')
      assert.equal(entry.matchedKeyword,type === 'comment' ? 'QUERO' : null)
      assert.equal(entry.commenterUsername,type === 'comment' ? 'conta_teste' : null)
      assert.equal(entry.outboundMessageId,type === 'story' && entry.status === 'sent' ? 'mid-teste' : null)
    }
    assert.equal(body.logs.at(-1).createdAt,type === 'comment' ? '2026-01-01T00:00:00.000Z' : '2026-01-01T12:00:00.000Z')
    const excluded = await (await logs(type,'101','from=2026-03-01&to=2026-03-02')).json()
    assert.equal(excluded.total,0); assert.deepEqual(excluded.logs,[])
  }
})

test('paginação por id descendente, empates de data, limite e página vazia', async () => {
  for (const type of ['comment','story']) {
    const first = await (await logs(type,'101',`${period}&page=1&limit=2`)).json()
    const again = await (await logs(type,'101',`${period}&page=1&limit=2`)).json()
    const second = await (await logs(type,'101',`${period}&page=2&limit=2`)).json()
    assert.deepEqual(first,again)
    assert.deepEqual(first.logs.map((l: {id:number})=>l.id),type === 'comment' ? [108,107] : [205,204])
    assert.deepEqual(second.logs.map((l: {id:number})=>l.id),type === 'comment' ? [106,105] : [203,202])
    const out = await (await logs(type,'101',`${period}&page=100&limit=200`)).json()
    assert.deepEqual(out.logs,[]); assert.equal(out.total,first.total)
    assert.equal((await logs(type,'101',`${period}&limit=200`)).status,200)
  }
})

test('chaves reais, id/slug, isolamento de empresa e escopo restrito', async () => {
  assert.equal((await metrics(period,'1','key-a',true)).status,200)
  assert.equal((await metrics(period,'empresa-b')).status,403)
  assert.equal((await logs('comment','201',period,'empresa-b')).status,403)
  assert.equal((await logs('story','201',period,'empresa-b')).status,403)
  const b = await (await metrics(period,'empresa-b','key-b')).json()
  assert.equal(b.automations.length,4)
  assert.ok(b.automations.every((r: {id:number})=>r.id >= 201))
  process.env.SAC_AGENT_FLAVIO_OTONI_KEY = 'restricted-key'
  try {
    assert.equal((await metrics(period,'flavio-otoni','restricted-key')).status,403)
    assert.equal((await logs('comment','101',period,'flavio-otoni','restricted-key')).status,403)
  } finally { delete process.env.SAC_AGENT_FLAVIO_OTONI_KEY }
})

test('404 indistinguível entre regra alheia e inexistente para ambos os tipos', async () => {
  for (const type of ['comment','story']) {
    const foreign = await logs(type,'201')
    const missing = await logs(type,'999999')
    assert.equal(foreign.status,404); assert.equal(missing.status,404)
    assert.deepEqual(await foreign.json(),await missing.json())
  }
  assert.equal((await metrics(period,'inexistente')).status,404)
})

test('401 sem chave ou chave inválida, inclusive alvo inexistente sem chave', async () => {
  for (const key of [null, '', 'incorreta']) {
    assert.equal((await metrics(period,'empresa-a',key)).status,401)
    assert.equal((await logs('comment','101',period,'empresa-a',key)).status,401)
    assert.equal((await logs('story','101',period,'empresa-a',key)).status,401)
  }
  assert.equal((await metrics(period,'inexistente',null)).status,401)
})

test('empresa sem regras retorna listas vazias e totais zero', async () => {
  const response = await metrics(period,'vazia','key-empty')
  const body = await response.json()
  assert.equal(response.status,200); assert.deepEqual(body.automations,[])
  assert.equal(body.totais.disparos,0); assert.equal(body.porTipo.story.disparos,0); assert.equal(body.porTipo.comment.disparos,0)
  for (const type of ['comment','story']) {
    const empty = await (await logs(type,'102')).json()
    assert.deepEqual(empty.logs,[]); assert.equal(empty.total,0)
  }
})

test('datas inválidas, limites de intervalo e tipo retornam 400 claro nas duas rotas', async () => {
  const invalid = ['from=lixo', 'to=', 'from=2026-02-30', 'from=0000-01-01&to=0000-01-02', 'from=0001-01-01T00:00:00%2B01:00&to=0001-01-02', 'to=9999-12-31T23:59:59-01:00', 'to=2026-13-01', 'from=2026-01-01T00:00:00',
    'from=2026-01-01T24:00:00Z', 'from=2026-02-01&to=2026-01-01', 'from=2024-01-01&to=2025-01-02', 'type=invalido', 'type=']
  for (const query of invalid) {
    const response = await metrics(query)
    assert.equal(response.status,400,query)
    assert.ok((await response.json()).error.length > 10)
    if (!query.startsWith('type')) assert.equal((await logs('comment','101',query)).status,400,query)
  }
  for (const type of ['all','invalido']) assert.equal((await logs(type)).status,400)
  assert.equal((await metrics('from=2024-01-01&to=2025-01-01')).status,200)
  assert.equal((await metrics('from=2026-01-01T03:00:00%2B03:00&to=2026-01-02')).status,200)
  const defaults = await (await metrics('')).json()
  assert.equal(Date.parse(defaults.period.to) - Date.parse(defaults.period.from),30 * 86400000)
})

test('inteiros estritos, máximo 200, ID inválido e paginação inválida', async () => {
  for (const query of ['page=0','page=-1','page=1.5','page=2x','page=','limit=0','limit=-5','limit=201','limit=1e2','page=9007199254740992']) {
    assert.equal((await logs('comment','101',`${period}&${query}`)).status,400,query)
  }
  for (const id of ['0','-1','1x','1.5','2147483648']) assert.equal((await logs('story',id)).status,400,id)
})
