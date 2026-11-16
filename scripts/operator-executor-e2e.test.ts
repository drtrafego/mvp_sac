import assert from 'node:assert/strict'
import { before, after, beforeEach, test, mock } from 'node:test'
import { randomUUID } from 'node:crypto'
import { operatorPlanner } from '../src/lib/operator/executor/planner'
import { executorHarness, type ExecutorHarness } from './operator-executor-harness'
let h: ExecutorHarness
before(async () => { h = await executorHarness() })
after(async () => { if (h) await h.close() })
beforeEach(async () => { await h.reset() })

test('planner padrão sem variável nem injeção enfileira no serviço real', async () => {
  const previous = process.env.OPERATOR_PLANNER
  try {
    delete process.env.OPERATOR_PLANNER
    assert.equal(operatorPlanner().tipo, 'fila')
    const result = await h.service.createOperatorService().submit({ companyId: h.A.id, userId: h.state.user, role: 'admin', requestText: 'Liste etapas', idempotencyKey: randomUUID() })
    assert.equal(result.job.status, 'em_execucao')
    const [queued] = await h.sql`SELECT estado FROM sac_operator_queue WHERE job_id=${result.job.id}`
    assert.equal(queued.estado, 'na_fila')
    assert.equal(h.modelBodies.length, 0)
    assert.equal(h.externalCalls.length, 0)
    for (const value of ['', 'sincrono', 'desconhecido']) {
      process.env.OPERATOR_PLANNER = value
      assert.equal(operatorPlanner().tipo, 'fila')
    }
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_PLANNER
    else process.env.OPERATOR_PLANNER = previous
  }
})

test('openrouter somente por variável explícita usa transporte simulado e não enfileira', async () => {
  const previous = process.env.OPERATOR_PLANNER
  const calls: string[] = []
  const transport = mock.method(globalThis, 'fetch', async (url: RequestInfo | URL) => {
    calls.push(String(url))
    return Response.json({ choices: [{ message: { content: JSON.stringify({ actions: [{ type: 'listar_etapas' }], response: 'ok' }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } })
  })
  try {
    process.env.OPERATOR_PLANNER = 'openrouter'
    assert.equal(operatorPlanner().tipo, 'sincrono')
    const result = await h.service.createOperatorService().submit({ companyId: h.A.id, userId: h.state.user, role: 'admin', requestText: 'Liste etapas', idempotencyKey: randomUUID() })
    assert.equal(result.job.status, 'concluido')
    assert.deepEqual(calls, ['https://openrouter.ai/api/v1/chat/completions'])
    assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_queue WHERE job_id=${result.job.id}`)[0].n, 0)
  } finally {
    transport.mock.restore()
    if (previous === undefined) delete process.env.OPERATOR_PLANNER
    else process.env.OPERATOR_PLANNER = previous
  }
})

test('SAC E2E: submit 202, claim sem PII, completar, replay e contabilização', async () => {
  const before = await h.protectedState()
  const r = await h.post('Mova Mariana Souza telefone 5511988887777 email pessoa@example.test palavra "CADERNO" link https://example.test/material para agendado')
  assert.equal(r.status, 202); assert.equal(r.body.job.status, 'em_execucao')
  const response = await h.claim.POST(h.request(h.ready)); assert.equal(response.status, 200)
  const c = await response.json()
  assert.deepEqual(Object.keys(c).sort(), ['jobId','leaseToken','epoch','leaseExpiraEm','prazo','modelo','sistema','pedido','schema'].sort())
  assert.doesNotMatch(JSON.stringify(c), /Mariana|Souza|5511988887777|pessoa@example|CADERNO|https:\/\/example/)
  assert.match(c.pedido, /\[T1\]/)
  const result = await h.callExecutor('complete', c, h.body(c)); assert.equal(result.status, 200); assert.deepEqual(result.body, { estado: 'aplicado', codigo: 'OK' })
  assert.deepEqual((await h.callExecutor('complete', c, h.body(c))).body, result.body)
  const [q] = await h.sql`SELECT * FROM sac_operator_queue WHERE job_id=${c.jobId}`
  assert.equal(q.estado, 'entregue'); assert.equal(q.tokens_entrada, 100); assert.equal(q.tokens_cache, 50); assert.equal(q.tokens_saida, 20)
  assert.equal((await h.sql`SELECT daily_tokens_reserved n FROM sac_operator_company_settings WHERE company_id=${h.A.id}`)[0].n, 70)
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_job_privados`)[0].n, 0)
  assert.equal(await h.protectedState(), before)
  assert.equal(h.modelBodies.length, 0)
})
test('T5: planos forjados e marcadores falsos encerram sem efeito', async () => {
  const rule = { type: 'criar_regra_instagram', gatilho: 'comentario', palavra: '[PALAVRA_1]', mensagem: '[DM_1]', correspondencia: 'contem', ativar: false }
  await h.sql`UPDATE sac_operator_company_settings SET allowed_actions=allowed_actions || '["criar_regra_instagram"]'::jsonb WHERE company_id=${h.A.id}`
  const plans = [
    { actions: [{ type: 'listar_etapas' }], response: 'ok', companyId: h.B.id },
    { actions: [{ type: 'listar_etapas', extra: true }], response: 'ok' },
    ...['pausar_bot', 'enviar_mensagem', 'excluir'].map(type => ({ actions: [{ type }], response: 'ok' })),
    { actions: [{ type: 'mover_etapa', lead: '[T99]', etapa: 'agendado' }], response: 'ok' },
    { actions: [{ ...rule, mensagem: 'https://forjado.test' }], response: 'ok' },
    { actions: [{ ...rule, palavra: 'LITERAL' }], response: 'ok' },
    { actions: Array(4).fill({ type: 'listar_etapas' }), response: 'ok' },
  ]
  const before = await h.protectedState()
  for (const plan of plans) {
    await h.submit(h.A, 'Mova Mariana Souza para agendado crie palavra "CADERNO" mensagem https://example.test/material')
    const c = (await h.take())!; assert.ok(c)
    const result = await h.callExecutor('complete', c, h.body(c, plan))
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.estado, 'recusado')
    assert.equal((await h.sql`SELECT status FROM sac_operator_jobs WHERE id=${c.jobId}`)[0].status, 'falhou')
    assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_job_privados WHERE job_id=${c.jobId}`)[0].n, 0)
  }
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_actions WHERE status='concluido'`)[0].n, 0)
  assert.equal(await h.protectedState(), before)
})
test('admin rebaixado após submit falha; dono e plataforma registrados são aceitos', async () => {
  await h.submit(); const c = (await h.take())!
  await h.sql`UPDATE company_members SET role='membro' WHERE company_id=${h.A.id} AND stack_auth_user_id=${h.state.user}`
  assert.deepEqual((await h.callExecutor('complete', c, h.body(c))).body, { estado: 'recusado', codigo: 'ADMIN_REQUIRED' })
  await h.sql`UPDATE companies SET stack_auth_user_id=${h.state.user} WHERE id=${h.A.id}`
  await h.submit(); const owner = (await h.take())!
  assert.equal((await h.callExecutor('complete', owner, h.body(owner))).body.estado, 'aplicado')
  await h.sql`UPDATE companies SET stack_auth_user_id=NULL WHERE id=${h.A.id}`
  h.state.role = 'platform_admin'
  await h.submit(); const platform = (await h.take())!
  assert.equal((await h.callExecutor('complete', platform, h.body(platform))).body.estado, 'aplicado')
})
test('T9: controle do bot é texto de recusa, sem tocar flags, envios ou leads', async () => {
  const before = await h.protectedState()
  await h.submit(h.I, 'Desligue o bot'); const c = (await h.take())!
  assert.equal((await h.callExecutor('complete', c, h.body(c, { actions: [{ type: 'recusar', motivo: 'controle_do_bot' }], response: 'recusa' }))).body.estado, 'recusado')
  assert.equal(await h.protectedState(), before)
})
test('efeito real: mover etapa uma vez; replay não duplica auditoria', async () => {
  await h.submit(h.A, 'Mova Mariana Souza para agendado'); const c = (await h.take())!
  const body = h.body(c, { actions: [{ type: 'mover_etapa', lead: '[T1] [T2]', etapa: 'agendado' }], response: 'ok' })
  assert.equal((await h.callExecutor('complete', c, body)).body.estado, 'aplicado')
  assert.equal((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=${h.leadA}`)[0].pipeline_stage, 'agendado')
  const count = (await h.sql`SELECT count(*)::int n FROM sac_audit_events WHERE reference_id=${c.jobId} OR payload->>'jobId'=${c.jobId}`)[0].n
  assert.equal((await h.callExecutor('complete', c, body)).status, 200)
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_audit_events WHERE reference_id=${c.jobId} OR payload->>'jobId'=${c.jobId}`)[0].n, count)
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_actions WHERE job_id=${c.jobId} AND status='concluido'`)[0].n, 1)
})


test('marcador desconhecido em leitura é MARKER_UNKNOWN, sem depender do prepare de escrita', async () => {
  await h.submit(h.A, 'Busque Mariana'); const c = (await h.take())!
  const r = await h.callExecutor('complete', c, h.body(c, { actions: [{ type: 'buscar_lead', query: '[T99]' }], response: 'ok' }))
  assert.equal(r.body.codigo, 'MARKER_UNKNOWN')
  assert.equal((await h.sql`SELECT status FROM sac_operator_jobs WHERE id=${c.jobId}`)[0].status, 'falhou')
})
