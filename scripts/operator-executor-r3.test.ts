import assert from 'node:assert/strict'
import { before, after, beforeEach, test, mock } from 'node:test'
import type { AcoesPlan } from '../src/lib/operator/acoes/catalog'
import { executorHarness, type ExecutorHarness } from './operator-executor-harness'
let h: ExecutorHarness
before(async () => { h = await executorHarness() })
after(async () => { if (h) await h.close() })
beforeEach(async () => { await h.reset() })

test('R3 DM forjada é recusada nos caminhos fila e síncrono sem efeito', async () => {
  const original = 'Crie regra de comentário palavra "CADERNO"'
  const plan: AcoesPlan = { actions: [{ type: 'criar_regra_instagram', gatilho: 'comentario', palavra: '[PALAVRA_1]', mensagem: 'Você ganhou um prêmio inventado.', correspondencia: 'contem', ativar: false }], response: 'ok' }
  await h.sql`UPDATE sac_operator_company_settings SET allowed_actions=allowed_actions || '["criar_regra_instagram"]'::jsonb WHERE company_id=${h.A.id}`
  const before = await h.protectedState()
  await h.submit(h.A, original); const c = (await h.take())!
  const queued = await h.callExecutor('complete', c, h.body(c, plan))
  assert.deepEqual(queued.body, { estado: 'recusado', codigo: 'INVALID_MESSAGE' })
  await assert.rejects(h.service.createOperatorService({ planner: { tipo: 'sincrono', adapter: { plan: async () => ({ plan, model: 'stub', usage: { inputTokens: 1, outputTokens: 1 } }) } } }).submit({ companyId: h.A.id, userId: h.state.user, role: 'admin', requestText: original, idempotencyKey: crypto.randomUUID() }), { code: 'INVALID_MESSAGE' })
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_jobs WHERE status='falhou' AND error_code='INVALID_MESSAGE'`)[0].n, 2)
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_actions WHERE status='concluido'`)[0].n, 0)
  assert.equal(await h.protectedState(), before)
})

test('R3 DM literal exige origem exata e marcadores não autorizam complemento inventado', async () => {
  const { validarMensagem } = await import('../src/lib/operator/acoes/validate')
  const original = 'Mensagem: Olá, ação especial para você!'
  for (const texto of ['Olá, ação especial para você! Ganhe dinheiro.', 'Ola, acao especial para voce!', 'Olá,  ação especial para você!', 'Texto de outro job', '[T1] complemento inventado']) {
    assert.throws(() => validarMensagem(texto, { original, markers: new Map([['[DM_1]', 'Olá, ação especial para você!']]) }), { code: 'INVALID_PLAN' }, texto)
  }
  assert.throws(() => validarMensagem('Olá, ação especial para você!', { original, markers: new Map([['[DM_1]', 'Olá, ação especial para você!']]) }), { code: 'INVALID_PLAN' })
  assert.equal(validarMensagem('[DM_1]', { markers: new Map([['[DM_1]', 'Olá, ação especial para você!']]) }).mensagem, 'Olá, ação especial para você!')
  assert.equal(validarMensagem('Mensagem cadastrada', { servidor: true }).mensagem, 'Mensagem cadastrada')
})

test('R3 claim ocioso faz uma instrução sem escrever contato recente', async () => {
  await h.take()
  const [before] = await h.sql`SELECT xmin::text AS version FROM sac_operator_executors WHERE id=${h.executor.id}`
  const spy = mock.method(h.db, 'execute')
  for (let i = 0; i < 30; i++) assert.equal(await h.take(), null)
  const instructions = spy.mock.callCount(); spy.mock.restore()
  const [after] = await h.sql`SELECT xmin::text AS version FROM sac_operator_executors WHERE id=${h.executor.id}`
  process.stdout.write(JSON.stringify({ proof: 'idle_30_claims', instructions, before: before.version, after: after.version }) + '\n')
  assert.equal(instructions, 30); assert.equal(after.version, before.version)
})

test('M07 enabled do claim é independente da varredura', async () => {
  await h.submit()
  await h.sql`UPDATE sac_operator_company_settings SET enabled=false WHERE company_id=${h.A.id}`
  assert.equal(await h.take(), null)
  assert.equal((await h.sql`SELECT estado FROM sac_operator_queue`)[0].estado, 'na_fila')
})

test('M08 claim recusa job que já consumiu duas tentativas', async () => {
  await h.submit()
  await h.sql`UPDATE sac_operator_queue SET tentativas=2`
  assert.equal(await h.take(), null)
  assert.equal((await h.sql`SELECT tentativas FROM sac_operator_queue`)[0].tentativas, 2)
})

test('M11 índice parcial impede segundo holder mesmo sem passar pelo claim', async () => {
  const a = await h.submit(); const b = await h.submit()
  await h.sql`UPDATE sac_operator_queue SET estado='reclamado' WHERE job_id=${a.job.id}`
  for (const estado of ['reclamado', 'aplicando']) {
    await assert.rejects(h.sql`UPDATE sac_operator_queue SET estado=${estado} WHERE job_id=${b.job.id}`, { code: '23505' })
  }
  await h.sql`UPDATE sac_operator_queue SET estado='entregue' WHERE job_id=${a.job.id}`
  await h.sql`UPDATE sac_operator_queue SET estado='reclamado' WHERE job_id=${b.job.id}`
})

test('M14 recuperação de lease e fail só repetem com mais de 90 segundos', async () => {
  for (const remaining of [89, 91]) for (const recovery of ['varrer', 'fail']) {
    await h.reset(); await h.submit(); const c = (await h.take())!
    await h.sql`UPDATE sac_operator_queue SET expira_em=now()+${remaining}*interval '1 second' WHERE job_id=${c.jobId}`
    if (recovery === 'varrer') {
      await h.sql`UPDATE sac_operator_queue SET lease_expira_em=now()-interval '1 second' WHERE job_id=${c.jobId}`
      await h.queue.varrer(h.A.id)
    } else await h.queue.falhar(h.lease(c), { epoch: c.epoch, codigo: 'CLI_ERROR' })
    assert.equal((await h.sql`SELECT estado FROM sac_operator_queue WHERE job_id=${c.jobId}`)[0].estado, remaining > 90 ? 'na_fila' : 'falhou', recovery)
  }
})

test('M20 admin inativo ou removido entre claim e complete não produz efeito', async () => {
  for (const removed of [false, true]) {
    await h.reset(); await h.submit(h.A, 'Mova Mariana Souza para agendado'); const c = (await h.take())!
    if (removed) await h.sql`DELETE FROM company_members WHERE company_id=${h.A.id} AND stack_auth_user_id=${h.state.user}`
    else await h.sql`UPDATE company_members SET status='inativo' WHERE company_id=${h.A.id} AND stack_auth_user_id=${h.state.user}`
    const before = await h.protectedState()
    assert.deepEqual((await h.callExecutor('complete', c, h.body(c, { actions: [{ type: 'mover_etapa', lead: '[T1] [T2]', etapa: 'agendado' }], response: 'ok' }))).body, { estado: 'recusado', codigo: 'ADMIN_REQUIRED' })
    assert.equal((await h.sql`SELECT status FROM sac_operator_jobs WHERE id=${c.jobId}`)[0].status, 'falhou')
    assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_actions WHERE job_id=${c.jobId} AND status='concluido'`)[0].n, 0)
    assert.equal(await h.protectedState(), before)
  }
})

test('M21 DELETE final protege empresa do lease com recibo de outra empresa', async () => {
  const { PgDialect } = await import('drizzle-orm/pg-core')
  await h.submit(); const c = (await h.take())!
  const execute = h.db.execute.bind(h.db)
  const spy = mock.method(h.db, 'execute', async (query: import('drizzle-orm').SQLWrapper) => {
    const compiled = new PgDialect().sqlToQuery(query.getSQL())
    if (!compiled.sql.includes('WITH delivered AS')) return execute(query)
    // Injeta um recibo alheio na fronteira do DELETE, isolando a guarda do lease.
    await h.sql`UPDATE sac_operator_job_privados SET company_id=${h.B.id} WHERE job_id=${c.jobId}`
    const poisoned = compiled.sql.replace('RETURNING q.job_id, q.company_id', `RETURNING q.job_id, ${h.B.id}::int AS company_id`)
    assert.notEqual(poisoned, compiled.sql)
    const rows = await h.sql.unsafe(poisoned, compiled.params as string[])
    return { rows }
  })
  try { await h.queue.completar(h.lease(c), h.body(c)) } finally { spy.mock.restore() }
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_job_privados WHERE job_id=${c.jobId} AND company_id=${h.B.id}`)[0].n, 1)
})

test('M27 formato sacop é obrigatório mesmo com hash correspondente cadastrado', async () => {
  await h.submit(); const c = (await h.take())!
  const { createHash } = await import('node:crypto')
  try { for (const token of ['x'.repeat(43), 'other_' + 'x'.repeat(43), 'sacop_' + 'a'.repeat(32), 'sacop_' + 'z'.repeat(64)]) {
    await h.sql`UPDATE sac_operator_executors SET token_hash=${createHash('sha256').update(token).digest('hex')} WHERE id=${h.executor.id}`
    assert.equal((await h.claim.POST(h.request({ ...h.ready, estado: 'pausado' }, token))).status, 401)
    for (const kind of ['heartbeat', 'complete', 'fail'] as const) assert.equal((await h.callExecutor(kind, c, {}, {}, token)).status, 401)
  } } finally {
    await h.sql`UPDATE sac_operator_executors SET token_hash=${createHash('sha256').update(h.executor.token).digest('hex')} WHERE id=${h.executor.id}`
  }
})

test('M32 corpo JSON válido acima de 32 KB é barrado antes de executar', async () => {
  await h.submit(); const c = (await h.take())!
  const raw = JSON.stringify(h.body(c)) + ' '.repeat(32769)
  const request = new Request('https://sac.test/api/operator-executor/jobs/' + c.jobId + '/complete', { method: 'POST', headers: { authorization: 'Bearer ' + h.executor.token, 'content-type': 'application/json', 'x-operator-lease': c.leaseToken }, body: raw })
  const { POST } = await import('../src/app/api/operator-executor/jobs/[jobId]/complete/route')
  assert.ok([400, 413].includes((await POST(request, { params: Promise.resolve({ jobId: c.jobId }) })).status))
  assert.equal((await h.sql`SELECT estado FROM sac_operator_queue WHERE job_id=${c.jobId}`)[0].estado, 'reclamado')
})

test('M33 complete recusa terceiro modelo concreto fora da lista fixa', async () => {
  await h.submit(); const c = (await h.take())!
  for (const modelo of ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-sol']) {
    assert.equal((await h.callExecutor('complete', c, { ...h.body(c), modelo })).status, 400)
  }
  assert.equal((await h.sql`SELECT estado FROM sac_operator_queue WHERE job_id=${c.jobId}`)[0].estado, 'reclamado')
})

test('M35 DELETE terminal não remove privados vencidos de outra empresa', async () => {
  const a = await h.submit(); const b = await h.submit(h.B)
  await h.sql`UPDATE sac_operator_job_privados SET apagar_apos=now()-interval '1 second'`
  await h.sql`UPDATE sac_operator_queue SET expira_em=now()-interval '1 second' WHERE job_id=${a.job.id}`
  await h.queue.varrer(h.A.id)
  assert.deepEqual((await h.sql`SELECT job_id FROM sac_operator_job_privados`).map(r => r.job_id), [b.job.id])
})

test('M36 UPDATE de quota terminal preserva saldo e versão da outra empresa', async () => {
  const a = await h.submit(); await h.submit(h.B)
  const [before] = await h.sql`SELECT daily_tokens_reserved, xmin::text FROM sac_operator_company_settings WHERE company_id=${h.B.id}`
  await h.sql`UPDATE sac_operator_queue SET expira_em=now()-interval '1 second' WHERE job_id=${a.job.id}`
  await h.queue.varrer(h.A.id)
  assert.equal((await h.sql`SELECT daily_tokens_reserved FROM sac_operator_company_settings WHERE company_id=${h.A.id}`)[0].daily_tokens_reserved, 0)
  const [after] = await h.sql`SELECT daily_tokens_reserved, xmin::text FROM sac_operator_company_settings WHERE company_id=${h.B.id}`
  assert.deepEqual(after, before)
})

test('R3 contato renova depois de 15 segundos e imediatamente ao mudar estado ou motivo', async () => {
  await h.take()
  const version = async () => (await h.sql`SELECT xmin::text AS v FROM sac_operator_executors WHERE id=${h.executor.id}`)[0].v
  let previous = await version()
  await h.take(); assert.equal(await version(), previous)
  await h.sql`UPDATE sac_operator_executors SET ultimo_contato_em=now()-interval '16 seconds' WHERE id=${h.executor.id}`
  previous = await version(); await h.take(); assert.notEqual(await version(), previous)
  previous = await version()
  await h.queue.reclamar(h.executor, { ...h.ready, versao: 'versão nova' })
  assert.equal(await version(), previous, 'Só mudar a versão respeita os 15 segundos')
  for (const body of [{ ...h.ready, estado: 'pausado' as const, motivo: 'CLI_SELFCHECK' }, { ...h.ready, estado: 'pausado' as const, motivo: 'USAGE_LIMIT' }, h.ready]) {
    previous = await version(); await h.queue.reclamar(h.executor, body); assert.notEqual(await version(), previous)
    previous = await version(); await h.queue.reclamar(h.executor, body); assert.equal(await version(), previous)
  }
})

test('R3 mensagem literal de outro job é recusada; marcador resolve apenas o job atual', async () => {
  await h.sql`UPDATE sac_operator_company_settings SET allowed_actions=allowed_actions || '["criar_regra_instagram"]'::jsonb WHERE company_id=${h.A.id}`
  const action = { type: 'criar_regra_instagram', gatilho: 'comentario', palavra: '[PALAVRA_1]', correspondencia: 'contem', ativar: false }
  await h.submit(h.A, 'Crie palavra "PRIMEIRO" mensagem "Olá do primeiro pedido"')
  const first = (await h.take())!
  await h.queue.falhar(h.lease(first), { epoch: first.epoch, codigo: 'TOOL_USE_DETECTED' })
  for (const mensagem of ['Olá do primeiro pedido', 'Olá do segundo pedido', '[DM_1]']) {
    await h.submit(h.A, 'Crie palavra "SEGUNDO" mensagem "Olá do segundo pedido"')
    const c = (await h.take())!
    const result = await h.callExecutor('complete', c, h.body(c, { actions: [{ ...action, mensagem }], response: 'ok' }))
    assert.equal(result.body.estado, mensagem !== '[DM_1]' ? 'recusado' : 'aplicado', JSON.stringify(result.body))
    if (mensagem !== '[DM_1]') assert.equal(result.body.codigo, 'INVALID_PLAN')
    else await h.sql`DELETE FROM instagram_comment_automations WHERE company_id=${h.A.id} AND keywords='SEGUNDO'`
  }
})
