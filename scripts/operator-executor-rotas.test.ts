import assert from 'node:assert/strict'
import { before, after, beforeEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { executorHarness, type ExecutorHarness } from './operator-executor-harness'
let h: ExecutorHarness
before(async () => { h = await executorHarness() })
after(async () => { if (h) await h.close() })
beforeEach(async () => { await h.reset() })

test('T1: token errado, hash desconhecido, revogado e cookies são 401 nas quatro rotas', async () => {
  await h.submit(); const c = (await h.take())!
  for (const token of ['errado', 'sacop_' + 'x'.repeat(43), h.executor.token]) {
    if (token === h.executor.token) await h.sql`UPDATE sac_operator_executors SET revogado_em=now() WHERE id=${h.executor.id}`
    assert.equal((await h.claim.POST(h.request(h.ready, token))).status, 401)
    for (const kind of ['heartbeat', 'complete', 'fail'] as const) assert.equal((await h.callExecutor(kind, c, {}, {}, token)).status, 401)
  }
  await h.sql`UPDATE sac_operator_executors SET revogado_em=NULL WHERE id=${h.executor.id}`
  for (const cookie of ['agent_auth_session=abc', 'stack-access-token=abc', '__Host-stack-refresh=abc']) {
    assert.equal((await h.claim.POST(h.request(h.ready, h.executor.token, { cookie }))).status, 401)
    for (const kind of ['heartbeat', 'complete', 'fail'] as const) assert.equal((await h.callExecutor(kind, c, {}, { cookie })).status, 401)
  }
})
test('T2: B fora de escopo e UUID inexistente retornam o mesmo 404', async () => {
  await h.submit(h.B); const c = (await h.take())!
  await h.sql`UPDATE sac_operator_executors SET empresas_permitidas=${h.sql.json([h.A.id])} WHERE id=${h.executor.id}`
  for (const kind of ['heartbeat', 'complete', 'fail'] as const) {
    const outside = await h.callExecutor(kind, c, {})
    const missing = await h.callExecutor(kind, { ...c, jobId: randomUUID() }, {})
    assert.equal(outside.status, 404); assert.equal(missing.status, 404); assert.deepEqual(outside.body, missing.body)
  }
})
test('corpos strict, modelos permitidos, Content-Type, no-store e status admin', async () => {
  await h.submit(); const c = (await h.take())!
  assert.equal((await h.claim.POST(h.request({ ...h.ready, companyId: h.A.id }))).status, 400)
  assert.equal((await h.callExecutor('complete', c, { ...h.body(c), companyId: h.A.id })).status, 400)
  assert.equal((await h.callExecutor('complete', c, { ...h.body(c), modelo: 'outro' })).status, 400)
  assert.equal((await h.callExecutor('complete', c, { ...h.body(c), uso: { entrada: 1, cache: 2, saida: 1 } })).status, 400)
  assert.equal((await h.callExecutor('heartbeat', c, { epoch: c.epoch, extra: true })).status, 400)
  assert.equal((await h.callExecutor('fail', c, { epoch: c.epoch, codigo: 'CLI_ERROR', extra: true })).status, 400)
  assert.equal((await h.callExecutor('heartbeat', c, { epoch: c.epoch }, { 'content-type': 'text/plain' })).status, 400)
  const good = await h.callExecutor('heartbeat', c, { epoch: c.epoch }); assert.equal(good.status, 200); assert.equal(good.headers.get('cache-control'), 'no-store')
  h.state.mode = 'member'; assert.equal((await h.status.GET()).status, 403)
  h.state.mode = 'agent'; assert.equal((await h.status.GET()).status, 401)
  h.state.mode = 'none'; assert.equal((await h.status.GET()).status, 401)
  h.state.mode = 'admin'; assert.equal((await h.status.GET()).status, 200)
})
test('120 requisições por executor por minuto; token separado possui janela própria', async () => {
  const e = await h.newExecutor()
  for (let i = 0; i < 120; i++) await h.auth.authenticateExecutor(h.request({}, e.token))
  await assert.rejects(h.auth.authenticateExecutor(h.request({}, e.token)), { status: 429 })
  const other = await h.newExecutor(); assert.ok(await h.auth.authenticateExecutor(h.request({}, other.token)))
})
test('claim pausado 204, disponível há menos de 40s e status expira privados da sessão', async () => {
  const paused = await h.claim.POST(h.request({ ...h.ready, estado: 'pausado', motivo: 'CLI_SELFCHECK' }))
  assert.equal(paused.status, 204); assert.equal(await paused.text(), '')
  assert.equal((await (await h.status.GET()).json()).disponivel, false)
  await h.sql`UPDATE sac_operator_executors SET estado_informado='pronto', ultimo_contato_em=now() WHERE id=${h.executor.id}`
  assert.equal((await (await h.status.GET()).json()).disponivel, true)
  await h.sql`UPDATE sac_operator_executors SET ultimo_contato_em=now()-interval '41 seconds' WHERE id=${h.executor.id}`
  assert.equal((await (await h.status.GET()).json()).disponivel, false)
  const a = await h.submit(); const b = await h.submit(h.B)
  await h.sql`UPDATE sac_operator_queue SET expira_em=now()-interval '1 minute'`
  h.state.company = h.A
  assert.equal((await h.status.GET()).status, 200)
  assert.equal((await h.sql`SELECT status FROM sac_operator_jobs WHERE id=${a.job.id}`)[0].status, 'falhou')
  assert.equal((await h.sql`SELECT status FROM sac_operator_jobs WHERE id=${b.job.id}`)[0].status, 'em_execucao')
})
test('T1: sacop não autentica /api/operator nem /api/v1; autenticação de agentes intacta', async () => {
  h.state.mode = 'none'
  const panel = await h.messages.POST(new NextRequest('https://sac.test/api/operator/messages', { method: 'POST', headers: { authorization: 'Bearer ' + h.executor.token, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Liste etapas' }) }))
  assert.equal(panel.status, 401)
  const v1 = await import('../src/app/api/v1/companies/route')
  assert.equal((await v1.GET(new NextRequest('https://sac.test/api/v1/companies', { headers: { authorization: 'Bearer ' + h.executor.token } }))).status, 401)
})
