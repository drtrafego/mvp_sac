import { before, after, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { NextRequest } from 'next/server'

if (!process.env.QA_PG_URL) throw new Error('QA_PG_URL deve apontar para Postgres descartável.')
const client = postgres(process.env.QA_PG_URL, { max: 1, onnotice: () => {} })
mock.module('@/lib/db', { namedExports: { db: drizzle(client) } })
let companyId: number | null = 1
class AuthError extends Error {}
class ForbiddenError extends Error {}
mock.module('@/lib/auth', { namedExports: {
  getCurrentCompany: async () => companyId === null ? null : { id: companyId },
  AuthError, ForbiddenError, forbiddenResponse: () => Response.json({}, { status: 403 }),
} })
let metrics: typeof import('../src/app/api/instagram-automations/metrics/route').GET
let logs: typeof import('../src/app/api/instagram-automations/[type]/[id]/logs/route').GET
const period = 'from=2026-01-01&to=2026-01-02'
const request = (query = period) => new NextRequest(`http://localhost/api/instagram-automations/metrics?${query}`)
const history = (type = 'comment', id = '101', query = period) => logs(request(query), { params: Promise.resolve({ type, id }) })
before(async () => {
  await client.unsafe(readFileSync('drizzle/0045_instagram_story_trigger.sql', 'utf8'))
  await client`truncate companies restart identity cascade`
  await client`insert into companies (id,name,slug) values (1,'A','painel-a'),(2,'B','painel-b')`
  for (const cid of [1,2]) {
    const rid = cid * 100 + 1
    await client`insert into instagram_comment_automations (id,company_id,name,dm_message) values (${rid},${cid},'Comentário','Mensagem')`
    await client`insert into instagram_story_automations (id,company_id,name,dm_message) values (${rid},${cid},'Story','Mensagem')`
    for (let i=0;i<12;i++) {
      await client`insert into instagram_comment_logs (company_id,automation_id,comment_id,commenter_id,commenter_username,status,created_at) values (${cid},${rid},${`${cid}-${i}`},${`${cid}${i}123456789`},'pessoa','sent','2026-01-01')`
      await client`insert into instagram_story_deliveries (company_id,automation_id,sender_id,story_id,status,occurred_at,created_at) values (${cid},${rid},${`${cid}${i}123456789`},'1','observed','2026-01-01','2026-01-01')`
    }
  }
  // Dados cruzados inconsistentes detectam retirada do filtro de empresa da consulta.
  await client`insert into instagram_comment_logs (company_id,automation_id,comment_id,commenter_id,status,created_at) values (2,101,'cruzado','999','failed','2026-01-01')`
  await client`insert into instagram_story_deliveries (company_id,automation_id,sender_id,story_id,status,occurred_at,created_at) values (2,101,'999','1','failed','2026-01-01','2026-01-01')`
  await client`insert into instagram_story_deliveries (company_id,sender_id,story_id,status,reason,occurred_at,created_at) values (1,'888','1','skipped','Nenhuma regra ativa corresponde à resposta','2026-01-01','2026-01-01')`
  await client`set default_transaction_read_only = on`
  metrics = (await import('../src/app/api/instagram-automations/metrics/route')).GET
  logs = (await import('../src/app/api/instagram-automations/[type]/[id]/logs/route')).GET
})
after(async () => { await client.end({ timeout: 2 }) })
test('empresa vem sempre da sessão; IDs, headers e slug do cliente não mudam tenant', async () => {
  for (const cid of [1,2]) {
    companyId = cid
    const response = await metrics(request(`${period}&company_id=${cid === 1 ? 2 : 1}&companyId=999&idOrSlug=painel-b`))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    const body = await response.json()
    assert.deepEqual(body.automations.map((r: {id:number}) => r.id), [cid*100+1,cid*100+1])
    for (const type of ['comment','story']) {
      assert.equal((await history(type, cid === 1 ? '201' : '101')).status, 404)
      const own = await (await history(type, String(cid*100+1), `${period}&company_id=999`)).json()
      assert.equal(own.total, 12)
      assert.ok(own.logs.every((l: {status:string}) => l.status !== 'failed'))
    }
  }
  companyId = 1
})
test('401 sem sessão mesmo com chave de integração e empresa na URL', async () => {
  companyId = null
  try {
    const req = request(`${period}&company_id=1`)
    req.headers.set('x-api-key','qualquer-chave')
    assert.equal((await metrics(req)).status,401)
    assert.equal((await history()).status,401)
  } finally { companyId=1 }
})
test('paginação real, máscara, status normalizado e ausência de linhas sem regra', async () => {
  for (const type of ['comment','story']) {
    const a = await (await history(type,'101',`${period}&limit=10&page=1`)).json()
    const b = await (await history(type,'101',`${period}&limit=10&page=2`)).json()
    assert.equal(a.total,12); assert.equal(a.logs.length,10); assert.equal(b.logs.length,2)
    assert.ok(a.logs.every((l: {id:number}) => !b.logs.some((m: {id:number}) => m.id === l.id)))
    assert.match(a.logs[0].senderId,/^\*{4}\d{4}$/)
    assert.equal(a.logs[0].status,type === 'comment' ? 'sent' : 'observed')
    assert.doesNotMatch(JSON.stringify(a),/Nenhuma regra|sem regra|123456789/i)
    assert.equal((await history(type,'999')).status,404)
  }
})
test('parâmetros de período, tipo, ID e paginação inválidos retornam 400', async () => {
  for (const query of ['from=2026-02-30','from=nope','from=2026-01-02&to=2026-01-01','from=2020-01-01&to=2026-01-01']) assert.equal((await metrics(request(query))).status,400)
  for (const type of ['all','invalid']) assert.equal((await history(type)).status,400)
  for (const id of ['0','-1','NaN','1.5']) assert.equal((await history('story',id)).status,400)
  for (const query of ['page=0','page=1.2','limit=201','limit=-1','page=9007199254740992','limit=abc']) assert.equal((await history('story','101',`${period}&${query}`)).status,400)
})
