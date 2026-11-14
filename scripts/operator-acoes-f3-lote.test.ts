import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createOperatorAcoesHarness, type QaHarness } from './operator-acoes-harness'

let h: QaHarness
let batch: typeof import('../src/lib/operator/acoes/batch')
test.before(async () => { h = await createOperatorAcoesHarness(); batch = await import('../src/lib/operator/acoes/batch') })
test.after(async () => { if (h) await h.close() })

async function seed(count: number, stage = 'qualificado') {
  const ids: number[] = []
  for (let i = 0; i < count; i++) ids.push(await h.lead(h.A.id, `Lote QA ${Date.now()} ${i}`, stage, `551199${String(Date.now()).slice(-5)}${String(i).padStart(2, '0')}`))
  return ids
}

function batchPlan(from = 'qualificado', to = 'agendado') {
  h.state.plan = { actions: [{ type: 'mover_etapa_lote', etapaOrigem: from, etapaDestino: to }], response: 'ok' }
}

test.beforeEach(async () => {
  h.fresh()
  await h.sql`DELETE FROM recovery_leads WHERE name LIKE 'Lote %'`
  await h.sql`UPDATE sac_operator_company_settings SET enabled=true, kill_switch=false,
    allowed_actions=${h.sql.json(['mover_etapa_lote'])}, daily_jobs_reserved=0, daily_tokens_reserved=0`
})

test('F3 lote: limites e código de confirmação são determinísticos', () => {
  assert.deepEqual(batch.classifyBatch(0), { kind: 'empty', count: 0, code: null })
  assert.equal(batch.classifyBatch(batch.LOTE_DIRETO_MAX).kind, 'direct')
  assert.deepEqual(batch.classifyBatch(batch.LOTE_DIRETO_MAX + 1), { kind: 'confirmation', count: 21, code: '21' })
  assert.equal(batch.classifyBatch(batch.LOTE_ABSOLUTO_MAX).kind, 'confirmation')
  assert.deepEqual(batch.classifyBatch(batch.LOTE_ABSOLUTO_MAX + 1), { kind: 'refused', count: 201, code: 'BATCH_TOO_LARGE' })
  assert.throws(() => batch.classifyBatch(-1), RangeError)
  assert.throws(() => batch.classifyBatch(1.5), RangeError)
})

test('F3 lote: confirmação não é aceita como execução direta', () => {
  // The executor calls moverLote only after the card is confirmed. This test
  // checks the public classification contract without opening a database.
  const snapshot = Array.from({ length: 21 }, (_, i) => ({ id: i + 1, pipelineStage: null, contextVersion: 1, effectiveStage: 'novo_contato' }))
  const result = batch.classifyBatch(snapshot.length)
  assert.equal(result.kind, 'confirmation')
  assert.equal(result.code, '21')
})

test('F3 lote PG: 20 executa direto e 21 exige código do cartão', async () => {
  const direct = await seed(20); batchPlan();
  const one = await h.post('Mova todos os leads qualificados para agendado')
  assert.equal(one.body.job.status, 'concluido', JSON.stringify(one.body))
  assert.equal((await h.sql`SELECT count(*)::int AS n FROM recovery_leads WHERE id = ANY(${direct}) AND pipeline_stage='agendado'`)[0].n, 20)

  const card = await seed(21); batchPlan();
  const pending = await h.post('Mova todos os leads qualificados para agendado')
  assert.equal(pending.body.job.status, 'aguardando_confirmacao', JSON.stringify(pending.body))
  assert.equal((await h.sql`SELECT count(*)::int AS n FROM recovery_leads WHERE id = ANY(${card}) AND pipeline_stage='qualificado'`)[0].n, 21)
  const confirmed = await h.call('confirm', pending.body.job.id, { planHash: pending.body.job.planHash, codigo: '21' })
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
  assert.equal((await h.sql`SELECT count(*)::int AS n FROM recovery_leads WHERE id = ANY(${card}) AND pipeline_stage='agendado'`)[0].n, 21)
  const second = await h.call('confirm', pending.body.job.id, { planHash: pending.body.job.planHash, codigo: '21' })
  assert.equal(second.status, 409)
})

test('F3 lote PG: 200 exige cartão e 201 recusa sem alterar', async () => {
  const card = await seed(200); batchPlan();
  const pending = await h.post('Mova todos os leads qualificados para agendado')
  assert.equal(pending.body.job.status, 'aguardando_confirmacao', JSON.stringify(pending.body))
  assert.equal((await h.sql`SELECT count(*)::int AS n FROM recovery_leads WHERE id = ANY(${card}) AND pipeline_stage='qualificado'`)[0].n, 200)

  await h.sql`DELETE FROM recovery_leads WHERE id = ANY(${card})`
  const tooMany = await seed(201); batchPlan();
  const refused = await h.post('Mova todos os leads qualificados para agendado')
  assert.equal(refused.status, 400)
  assert.equal(refused.body.code, 'BATCH_TOO_LARGE')
  assert.equal((await h.sql`SELECT count(*)::int AS n FROM recovery_leads WHERE id = ANY(${tooMany}) AND pipeline_stage='qualificado'`)[0].n, 201)
})

test('F3 lote PG: undo restaura NULL e etapa explícita no mesmo lote', async () => {
  const nullLead = await h.lead(h.A.id, `Lote undo null ${Date.now()}`, null)
  const explicitLead = await h.lead(h.A.id, `Lote undo explícito ${Date.now()}`, 'novo_contato')
  const prepared = await h.prepared([{ type: 'mover_etapa_lote', etapaOrigem: 'novo_contato', etapaDestino: 'agendado' }], 'Mova os leads novos para agendado')
  const [action] = prepared.actions
  const done = await h.execute.executarJob(h.actor(), prepared.jobId)
  assert.equal(done[0].status, 'concluido', JSON.stringify(done))
  assert.deepEqual((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id IN (${nullLead}, ${explicitLead}) ORDER BY id`).map(row => row.pipeline_stage), ['agendado', 'agendado'])
  await h.flow.finalizarJob(h.actor(), prepared.jobId, h.flow.outcome(done))
  const undone = await h.call('undo', action.id)
  assert.equal(undone.status, 202, JSON.stringify(undone.body))
  assert.deepEqual((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id IN (${nullLead}, ${explicitLead}) ORDER BY id`).map(row => row.pipeline_stage), [null, 'novo_contato'])
})

test('F3 lote PG: lead alterado depois do snapshot fica fora e não é desfeito', async () => {
  const ids = await seed(2, 'qualificado')
  const prepared = await h.prepared([{ type: 'mover_etapa_lote', etapaOrigem: 'qualificado', etapaDestino: 'agendado' }], 'Mova o lote qualificado')
  await h.sql`UPDATE recovery_leads SET pipeline_stage='perdido' WHERE id=${ids[0]}`
  const done = await h.execute.executarJob(h.actor(), prepared.jobId)
  assert.equal(done[0].status, 'concluido', JSON.stringify(done))
  assert.equal((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=${ids[0]}`)[0].pipeline_stage, 'perdido')
  assert.equal((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=${ids[1]}`)[0].pipeline_stage, 'agendado')
  assert.ok(done[0].afterSnapshot?.ignorados?.includes(ids[0]))
  await h.flow.finalizarJob(h.actor(), prepared.jobId, h.flow.outcome(done))
  const undone = await h.call('undo', prepared.actions[0].id)
  assert.equal(undone.status, 202, JSON.stringify(undone.body))
  assert.equal((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=${ids[0]}`)[0].pipeline_stage, 'perdido')
  assert.equal((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=${ids[1]}`)[0].pipeline_stage, 'qualificado')
})

test('F3 lote PG: duas confirmações concorrentes assentam uma única vez', async () => {
  await seed(21, 'qualificado'); batchPlan()
  const pending = await h.post('Mova o lote qualificado para agendado')
  assert.equal(pending.body.job.status, 'aguardando_confirmacao', JSON.stringify(pending.body))
  const body = { planHash: pending.body.job.planHash, codigo: '21' }
  const results = await Promise.all([h.call('confirm', pending.body.job.id, body), h.call('confirm', pending.body.job.id, body)])
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409])
  assert.equal((await h.sql`SELECT count(*)::int AS n FROM sac_operator_actions WHERE job_id=${pending.body.job.id} AND status='concluido'`)[0].n, 1)
})

test('F3 lote PG: snapshot forjado com lead de outra empresa não produz efeito', async () => {
  const prepared = await h.prepared([{ type: 'mover_etapa_lote', etapaOrigem: 'qualificado', etapaDestino: 'agendado' }], 'Mova o lote')
  const foreign = await h.lead(h.B.id, `Lote estrangeiro ${Date.now()}`, 'qualificado')
  const action = prepared.actions[0]
  await h.sql`UPDATE sac_operator_actions SET request_json = jsonb_set(request_json, '{lote}', ${h.sql.json([{ id: foreign, pipelineStage: 'qualificado', contextVersion: 1, etapaEfetiva: 'qualificado' }])}::jsonb) WHERE id=${action.id}`
  const before = await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=${foreign}`
  await assert.rejects(h.execute.executarAcao(h.actor(), prepared.jobId, action, randomUUID()), { status: 404, code: 'LEAD_NOT_FOUND' })
  assert.equal((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=${foreign}`)[0].pipeline_stage, before[0].pipeline_stage)
})
