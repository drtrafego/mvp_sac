/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, mock, test } from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import { createOperatorAcoesHarness, type QaHarness } from './operator-acoes-harness'

let h: QaHarness
const dialect = new PgDialect()
const text = 'Crie regra palavra CADERNO mensagem https://example.test/material'
const create = (ativar = false) => ({ type: 'criar_regra_instagram' as const, gatilho: 'comentario' as const, palavra: '[PALAVRA_1]', mensagem: '[LINK_1]', correspondencia: 'contem' as const, ativar })
before(async () => { h = await createOperatorAcoesHarness() })
after(async () => { if (h) await h.close() })
beforeEach(async () => {
  h.fresh()
  await h.sql`UPDATE sac_operator_company_settings SET enabled=true, kill_switch=false, allowed_actions='["criar_regra_instagram","ativar_regra_instagram"]', max_jobs_per_day=1000, daily_usage_date=NULL, daily_jobs_reserved=0, daily_tokens_reserved=0`
  await h.sql`DELETE FROM instagram_comment_logs`
  await h.sql`DELETE FROM instagram_comment_automations`
  await h.sql`DELETE FROM sac_operator_actions`
  await h.sql`DELETE FROM sac_operator_jobs`
  await h.sql`DELETE FROM sac_operator_locks`
})
const snapshot = async () => ({
  jobs: await h.sql`SELECT to_jsonb(t) v FROM sac_operator_jobs t ORDER BY id`,
  actions: await h.sql`SELECT to_jsonb(t) v FROM sac_operator_actions t ORDER BY id`,
  rules: await h.sql`SELECT to_jsonb(t) v FROM instagram_comment_automations t ORDER BY id`,
  audit: await h.sql`SELECT to_jsonb(t) v FROM sac_audit_events t ORDER BY id`,
})

// Executa SQL gerado pelo produto. Renumera parâmetros ao isolar uma CTE,
// sem copiar o predicado que o teste precisa proteger.
function directSql(sql: string, params: unknown[]) {
  const values: any[] = []
  const command = sql.replace(/\$(\d+)/g, (_, n: string) => {
    values.push(params[Number(n) - 1])
    return `$${values.length}`
  })
  return h.sql.unsafe(command, values)
}

test('M32: plano forjado não troca a empresa da sessão nem chega ao ator', async () => {
  const { createOperatorService } = await import('../src/lib/operator/service')
  const actors: number[] = []
  const service = createOperatorService({ acoes: { handleWritePlan: async input => {
    actors.push(input.ator.companyId)
    return h.flow.handleWritePlan(input)
  } } })
  for (const company of [h.A, h.B]) {
    h.state.company = company
    h.state.plan = { actions: [create()], response: 'ok' }
    const valid = await service.submit({ ...h.actor(), requestText: text, idempotencyKey: randomUUID() })
    assert.equal(valid.job.status, 'concluido')
    assert.equal(actors.at(-1), company.id, 'O ator usa a empresa autenticada')
    assert.equal(valid.job.companyId, company.id)
  }
  assert.deepEqual(actors, [h.A.id, h.B.id])
  h.fresh()
  const business = await h.sql`SELECT to_jsonb(t) v FROM instagram_comment_automations t ORDER BY id`
  const actionsBefore = await h.sql`SELECT to_jsonb(t) v FROM sac_operator_actions t ORDER BY id`
  for (const field of ['companyId', 'company_id', 'empresa', 'alvoEmpresa']) {
    for (const nested of [false, true]) {
      h.state.plan = nested
        ? { actions: [{ ...create(), [field]: h.B.id }], response: 'ok' }
        : { actions: [create()], response: 'ok', [field]: h.B.id }
      const calls = h.modelBodies.length
      const response = await h.post(text)
      assert.equal(h.modelBodies.length, calls + 1, 'Exercita a resposta do modelo, não o corpo HTTP')
      assert.equal(response.status, 202)
      assert.equal(response.body.job.status, 'falhou', `${field}, ação=${nested}`)
      assert.equal(response.body.job.errorCode, 'MODEL_OR_READ_FAILURE')
      const job = await h.flow.getJob(h.A.id, response.body.job.id)
      assert.equal(job.companyId, h.A.id)
      assert.equal(job.requestedByUserId, h.state.user)
    }
  }
  // Também cobre a validação do serviço se um adaptador entregar plano sem validar.
  for (const field of ['companyId', 'company_id', 'empresa', 'alvoEmpresa']) {
    const injected = createOperatorService({
      model: { plan: async () => ({ plan: { actions: [create()], response: 'ok', [field]: h.B.id }, usage: { inputTokens: 1, outputTokens: 1 }, model: 'stub' }) },
      acoes: { handleWritePlan: async input => { actors.push(input.ator.companyId); return h.flow.handleWritePlan(input) } },
    })
    const result = await injected.submit({ ...h.actor(), requestText: text, idempotencyKey: randomUUID() })
    assert.equal(result.job.status, 'falhou', field)
    assert.deepEqual(actors, [h.A.id, h.B.id], 'Plano forjado é recusado antes de construir/executar o ator')
  }
  assert.deepEqual(await h.sql`SELECT to_jsonb(t) v FROM instagram_comment_automations t ORDER BY id`, business)
  assert.deepEqual(await h.sql`SELECT to_jsonb(t) v FROM sac_operator_actions t ORDER BY id`, actionsBefore)
  assert.equal((await h.post(text, randomUUID(), { company_id: h.B.id })).status, 400)
})

test('M07: carregarAcao por UUID alheio recusa sem depender de getJob ou Desfazer', async () => {
  const a = await h.prepared([create()], text, h.A)
  const b = await h.prepared([create()], text, h.B)
  const before = await snapshot()
  for (const [company, own, foreign] of [[h.A, a, b], [h.B, b, a]] as const) {
    assert.equal((await h.execute.carregarAcao(company.id, own.actions[0].id)).companyId, company.id)
    await assert.rejects(h.execute.carregarAcao(company.id, foreign.actions[0].id), { status: 404, code: 'ACTION_NOT_FOUND' })
  }
  assert.deepEqual(await snapshot(), before)
})

test('M09b: recibo de criação isola empresa mesmo sem a proteção redundante do gate', async () => {
  const { regraSql } = await import('../src/lib/operator/acoes/sql')
  const a = await h.prepared([create()], text, h.A)
  const actor = h.actor()
  const b = await h.prepared([create()], text, h.B)
  const [foreignRule] = await h.sql`INSERT INTO instagram_comment_automations (company_id,name,keywords,dm_message,is_active) VALUES (${h.B.id},'Regra alheia','PRIVADA','Mensagem preservada',false) RETURNING id`
  const forged = { ...a.actions[0], id: b.actions[0].id, requestJson: { ...a.actions[0].requestJson, regra: { ...a.actions[0].requestJson.regra!, id: foreignRule.id } } }
  const holder = randomUUID()
  const { adquirirTrava, liberarTrava } = await import('../src/lib/operator/acoes/lock')
  assert.equal(await adquirirTrava(h.A.id, holder), true)
  const before = await snapshot()
  try {
    const query = dialect.sqlToQuery(regraSql(actor, forged, holder, foreignRule.id, foreignRule.id + 1))
    const result = await directSql(query.sql, query.params)
    assert.equal(result[0].efeitos, 0)
    assert.deepEqual(await snapshot(), before)
    // O gate também filtra empresa. Isolamos o UPDATE real do recibo para
    // provar seu próprio filtro, mesmo que outra camada já tenha autorizado.
    const receipt = query.sql.match(/\), clm AS \(([\s\S]*?)\), eff AS \(/)?.[1]
    assert.ok(receipt, 'CTE de recibo gerada pelo produto precisa ser exercitada')
    const rejected = await directSql(`WITH gate AS (SELECT 1) ${receipt}`, query.params)
    assert.equal(rejected.length, 0, 'Recibo de outra empresa não pode ser reivindicado')
    assert.deepEqual(await snapshot(), before)
    const own = dialect.sqlToQuery(regraSql(actor, a.actions[0], holder, foreignRule.id, foreignRule.id + 1))
    const ownReceipt = own.sql.match(/\), clm AS \(([\s\S]*?)\), eff AS \(/)?.[1]
    assert.ok(ownReceipt)
    assert.equal((await directSql(`WITH gate AS (SELECT 1) ${ownReceipt}`, own.params)).length, 1, 'Controle positivo do UPDATE isolado')
    assert.deepEqual(await h.sql`SELECT to_jsonb(t) v FROM instagram_comment_automations t ORDER BY id`, before.rules)
  } finally { await liberarTrava(h.A.id, holder) }
})

test('M33: claim SQL direto de cartão alheio não altera job nem auditoria', async () => {
  h.state.plan = { actions: [create(true)], response: 'ok' }
  const response = await h.post(text)
  const id = response.body.job.id
  const job = await h.flow.getJob(h.A.id, id)
  assert.equal(job.waitingReason, 'confirmacao')
  let claim: ReturnType<PgDialect['sqlToQuery']> | undefined
  const execute = h.db.execute.bind(h.db)
  const spy = mock.method(h.db, 'execute', async (query: any) => {
    const compiled = dialect.sqlToQuery(query)
    if (compiled.sql.includes('WITH owner AS') && compiled.sql.includes('operator_card_confirmed')) {
      claim = compiled
      return { rows: [] }
    }
    return execute(query)
  })
  try {
    await assert.rejects(h.flow.confirmJob(h.actor(), id, { planHash: job.planHash!, codigo: 'CADERNO' }), { status: 409, code: 'INVALID_STATE' })
  } finally { spy.mock.restore() }
  assert.ok(claim, 'Captura obrigatória da instrução real de claim')
  const before = await snapshot()
  // Não há helper de claim exportado. Reexecutamos somente a instrução
  // capturada, com o ator B e o cartão A, sem passar por getJob/confirmJob.
  const claimDirect = (companyId: number) => directSql(claim!.sql, claim!.params.map(p => p === h.A.id ? companyId : p))
  assert.equal((await claimDirect(h.B.id)).length, 0)
  assert.deepEqual(await snapshot(), before)
  assert.equal((await claimDirect(h.A.id)).length, 1, 'Dono correto consegue reivindicar')
  assert.equal((await claimDirect(h.A.id)).length, 0, 'Uma única reivindicação')
  const after = await h.flow.getJob(h.A.id, id)
  assert.equal(after.status, 'em_execucao')
  assert.equal(after.confirmedBy, h.state.user)
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_audit_events WHERE type='operator_card_confirmed' AND reference_id=${id}`)[0].n, 1)
})

test('M18: holder antigo não libera trava expirada e adquirida por outro dono', async () => {
  const { adquirirTrava, liberarTrava } = await import('../src/lib/operator/acoes/lock')
  const old = randomUUID(); const current = randomUUID(); const other = randomUUID()
  assert.equal(await adquirirTrava(h.A.id, old), true)
  await h.sql`UPDATE sac_operator_locks SET locked_until=now()-interval '1 second' WHERE company_id=${h.A.id}`
  assert.equal(await adquirirTrava(h.A.id, current), true)
  assert.equal(await adquirirTrava(h.B.id, other), true)
  const before = await h.sql`SELECT * FROM sac_operator_locks ORDER BY company_id`
  await liberarTrava(h.A.id, old)
  assert.deepEqual(await h.sql`SELECT * FROM sac_operator_locks ORDER BY company_id`, before)
  await liberarTrava(h.B.id, current)
  assert.deepEqual(await h.sql`SELECT * FROM sac_operator_locks ORDER BY company_id`, before)
  assert.equal(await adquirirTrava(h.A.id, old), false)
  await liberarTrava(h.A.id, current)
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_locks WHERE company_id=${h.A.id}`)[0].n, 0)
  assert.equal((await h.sql`SELECT holder FROM sac_operator_locks WHERE company_id=${h.B.id}`)[0].holder, other)
  await liberarTrava(h.B.id, other)
})
