import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, test } from 'node:test'
import { createOperatorAcoesHarness, type QaHarness } from './operator-acoes-harness'

let h: QaHarness
before(async () => { h = await createOperatorAcoesHarness() })
after(async () => { if (h) await h.close() })
beforeEach(() => h.fresh())

test('12 POST reais com a mesma chave: um job, nota, movimento e chamada do modelo', async () => {
  const id = await h.lead(h.A.id, 'Mariana Souza', null, '5511912345678')
  h.state.plan = { actions: [{ type: 'mover_etapa', lead: '[T1]', etapa: 'agendado' }, { type: 'anotar_lead', lead: '[T1]', texto: 'pediu retorno' }], response: 'ok' }
  const key = randomUUID(); const calls = h.modelBodies.length
  const responses = await Promise.all(Array.from({ length: 12 }, () => h.post(`Mova #${id} para agendado e anote combinado`, key)))
  assert.equal(responses.filter(r => r.status === 202).length, 1)
  assert.equal(responses.filter(r => r.status === 200).length, 11)
  const [job] = await h.sql`SELECT count(*)::int n FROM sac_operator_jobs WHERE company_id=${h.A.id} AND idempotency_key=${key}`
  const [actions] = await h.sql`SELECT count(*)::int n FROM sac_operator_actions WHERE job_id IN (SELECT id FROM sac_operator_jobs WHERE company_id=${h.A.id} AND idempotency_key=${key}) AND status='concluido'`
  const [notes] = await h.sql`SELECT count(*)::int n FROM sac_internal_notes WHERE lead_id=${id}`
  const [lead] = await h.sql`SELECT pipeline_stage,context_version FROM recovery_leads WHERE id=${id}`
  assert.equal(job.n, 1); assert.equal(actions.n, 2); assert.equal(notes.n, 1)
  assert.equal(lead.pipeline_stage, 'agendado'); assert.equal(lead.context_version, 2); assert.equal(h.modelBodies.length - calls, 1)
})

test('dois jobs preparados no mesmo contexto: exatamente um efeito, outro CONFLICT', async () => {
  const id = await h.lead()
  const first = await h.prepared([{ type: 'mover_etapa', lead: '[T1]', etapa: 'agendado' }], `Mova #${id} para agendado`)
  const second = await h.prepared([{ type: 'mover_etapa', lead: '[T1]', etapa: 'qualificado' }], `Mova #${id} para qualificado`)
  const results = await Promise.all([first, second].map(p => h.execute.executarAcao(h.actor(), p.jobId, p.actions[0])))
  assert.equal(results.filter(r => r.status === 'concluido').length, 1)
  assert.equal(results.filter(r => r.afterSnapshot?.erro === 'CONFLICT').length, 1)
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_audit_events WHERE lead_id=${id}`)[0].n, 1)
})

test('a mesma nota executada em paralelo só insere uma nota e uma auditoria', async () => {
  const id = await h.lead()
  const p = await h.prepared([{ type: 'anotar_lead', lead: '[T1]', texto: 'pediu retorno' }], `Anote #${id} combinado`)
  await Promise.all(Array.from({ length: 12 }, () => h.execute.executarAcao(h.actor(), p.jobId, p.actions[0])))
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_internal_notes WHERE lead_id=${id}`)[0].n, 1)
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_audit_events WHERE lead_id=${id}`)[0].n, 1)
  assert.equal((await h.execute.carregarAcao(h.A.id, p.actions[0].id)).status, 'concluido')
})

test('12 desfazeres simultâneos reutilizam um job e uma compensação', async () => {
  const id = await h.lead()
  h.state.plan = { actions: [{ type: 'mover_etapa', lead: '[T1]', etapa: 'agendado' }], response: 'ok' }
  const r = await h.post(`Mova #${id} para agendado`)
  const view = await h.call('acoes', r.body.job.id)
  const aid = view.body.acoes[0].id
  const responses = await Promise.all(Array.from({ length: 12 }, () => h.call('undo', aid)))
  assert.ok(responses.every(r => [200, 202].includes(r.status)), JSON.stringify(responses))
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_jobs WHERE company_id=${h.A.id} AND idempotency_key=${'undo:' + aid}`)[0].n, 1)
  const [lead] = await h.sql`SELECT pipeline_stage,context_version FROM recovery_leads WHERE id=${id}`
  assert.equal(lead.pipeline_stage, null); assert.equal(lead.context_version, 3)
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_audit_events WHERE lead_id=${id}`)[0].n, 2)
})

test('escolhas simultâneas e cancelamento competem pela posse do job', async () => {
  h.state.plan = { actions: [{ type: 'mover_etapa', lead: '[T1] [T2]', etapa: 'agendado' }], response: 'ok' }
  const r = await h.post('Mova João Silva para agendado'); const id = r.body.job.id
  const view = await h.call('acoes', id); const aid = view.body.acoes[0].id
  const choices = [{ actionId: aid, leadId: h.twin1 }, { actionId: aid, leadId: h.twin2 }]
  const replies = await Promise.all([...choices.map(c => h.call('clarify', id, c)), h.call('cancel', id)])
  assert.equal(replies.filter(r => r.status === 200).length, 1, JSON.stringify(replies))
  assert.equal(replies.filter(r => r.status === 409).length, 2)
  const [a] = await h.sql`SELECT status, request_json FROM sac_operator_actions WHERE id=${aid}`
  if (replies[2].status === 200) { assert.equal(a.status, 'cancelado'); assert.ok(a.request_json.esclarecimento) }
  else { assert.equal(a.status, 'concluido'); assert.equal(a.request_json.leadId, choices[replies[0].status === 200 ? 0 : 1].leadId) }
})

test('T-ATOM-2: recibo invalidado depois do gate reverte efeito e auditoria na CTE real', async () => {
  const id = await h.lead()
  const p = await h.prepared([{ type: 'mover_etapa', lead: '[T1]', etapa: 'agendado' }], `Mova #${id} para agendado`)
  const lock = await h.sql.reserve()
  await lock`SELECT pg_advisory_lock(812731)`
  await h.sql.unsafe(`CREATE FUNCTION qa_block_stage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = ${id} THEN PERFORM pg_advisory_xact_lock(812731); END IF; RETURN NEW; END $$`)
  await h.sql`CREATE TRIGGER qa_block_stage BEFORE UPDATE ON recovery_leads FOR EACH ROW EXECUTE FUNCTION qa_block_stage()`
  let pending: ReturnType<typeof h.execute.executarAcao> | undefined
  try {
    pending = h.execute.executarAcao(h.actor(), p.jobId, p.actions[0])
    let blocked = false
    for (let i = 0; i < 100; i++) {
      const [r] = await h.sql`SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND objid=812731 AND NOT granted`
      if (r.n) { blocked = true; break }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(blocked, true, 'CTE real deve alcançar o efeito depois do gate')
    await h.sql`UPDATE sac_operator_actions SET status='cancelado' WHERE id=${p.actions[0].id}`
    await lock`SELECT pg_advisory_unlock(812731)`
    const result = await pending
    assert.equal(result.afterSnapshot?.erro, 'OPERATOR_INCONSISTENT')
    const [lead] = await h.sql`SELECT pipeline_stage,context_version FROM recovery_leads WHERE id=${id}`
    assert.equal(lead.pipeline_stage, null); assert.equal(lead.context_version, 1)
    assert.equal((await h.sql`SELECT count(*)::int n FROM sac_audit_events WHERE lead_id=${id}`)[0].n, 0)
  } finally {
    await lock`SELECT pg_advisory_unlock_all()`; lock.release()
    if (pending) await pending
    await h.sql`DROP TRIGGER qa_block_stage ON recovery_leads`
    await h.sql`DROP FUNCTION qa_block_stage()`
  }
})
