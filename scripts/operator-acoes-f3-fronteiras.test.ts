/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import { createOperatorAcoesHarness, type QaHarness } from './operator-acoes-harness'

let h: QaHarness
const permissions = ['criar_regra_story', 'ativar_regra_story', 'mover_etapa']
before(async () => { h = await createOperatorAcoesHarness() })
after(async () => { if (h) await h.close() })
beforeEach(async () => {
  h.fresh()
  await h.sql`UPDATE sac_operator_company_settings SET enabled=true, kill_switch=false,
    allowed_actions=${h.sql.json(permissions)}, link_domains='[]', max_jobs_per_day=1000,
    daily_usage_date=NULL, daily_jobs_reserved=0, daily_tokens_reserved=0`
  await h.sql`DELETE FROM instagram_story_deliveries`
  await h.sql`DELETE FROM instagram_story_automations`
  await h.sql`DELETE FROM sac_operator_actions`
  await h.sql`DELETE FROM sac_operator_jobs`
  await h.sql`DELETE FROM sac_operator_locks`
})

const story = (palavra = '[PALAVRA_1]') => ({
  type: 'criar_regra_story', palavra, mensagem: '[DM_1]', correspondencia: 'contem', ativar: 'nao',
})
function plan(actions: unknown[]) { h.state.plan = { actions, response: 'ok' } }
async function createStory() {
  plan([story()])
  const result = await h.post('Crie regra de story palavra CADERNO mensagem https://example.test/x')
  assert.equal(result.body.job?.status, 'concluido', JSON.stringify(result.body))
  return (await h.sql`SELECT id FROM instagram_story_automations WHERE company_id=${h.A.id}`)[0].id as number
}
async function activate(id: number, modo: 'teste' | 'envio') {
  plan([{ type: 'ativar_regra_story', regra: `#${id}`, modo }])
  return h.post(`Ative a regra de story #${id} em ${modo}`)
}
async function confirmation(id: string) {
  const view = await h.call('acoes', id)
  return { planHash: view.body.job.planHash, codigo: 'CADERNO' }
}

test('F3-R2-Q21: enabled_at é NULL na criação e reinicia ao ativar observe e send', async () => {
  const id = await createStory()
  const [created] = await h.sql`SELECT is_active,mode,enabled_at FROM instagram_story_automations WHERE id=${id}`
  assert.deepEqual(created, { is_active: false, mode: 'observe', enabled_at: null })
  const [start] = await h.sql`SELECT now()::text instant`
  assert.equal((await activate(id, 'teste')).body.job.status, 'concluido')
  const [observed] = await h.sql`SELECT is_active,mode,enabled_at,
    enabled_at BETWEEN ${start.instant}::timestamptz AND now() AS fresh
    FROM instagram_story_automations WHERE id=${id}`
  assert.equal(observed.is_active, true)
  assert.equal(observed.mode, 'observe')
  assert.notEqual(observed.enabled_at, null)
  assert.equal(observed.fresh, true, 'Observe inicia o corte temporal na ativação')

  // Um corte antigo conhecido permite verificar renovação sem sleep ou precisão do JS.
  await h.sql`UPDATE instagram_story_automations SET enabled_at=now()-interval '1 day' WHERE id=${id}`
  const pending = await activate(id, 'envio')
  assert.equal(pending.body.job.waitingReason, 'confirmacao')
  assert.equal((await h.sql`SELECT mode FROM instagram_story_automations WHERE id=${id}`)[0].mode, 'observe')
  const [sendStart] = await h.sql`SELECT now()::text instant`
  assert.equal((await h.call('confirm', pending.body.job.id, await confirmation(pending.body.job.id))).status, 200)
  const [sent] = await h.sql`SELECT is_active,mode,
    enabled_at BETWEEN ${sendStart.instant}::timestamptz AND now() AS fresh
    FROM instagram_story_automations WHERE id=${id}`
  assert.deepEqual(sent, { is_active: true, mode: 'send', fresh: true })
})

test('F3-R2-Q27: prazo vence entre a leitura válida e o CAS final, sem ativação', async () => {
  const ruleId = await createStory()
  const pending = await activate(ruleId, 'envio')
  assert.equal(pending.body.job.waitingReason, 'confirmacao')
  const id = pending.body.job.id
  const input = await confirmation(id)
  const read = await h.flow.getJob(h.A.id, id)
  assert.ok(read.confirmationExpiresAt!.getTime() > Date.now())
  const execute = h.db.execute.bind(h.db)
  const dialect = new PgDialect()
  let claims = 0
  const spy = mock.method(h.db, 'execute', async (query: any) => {
    const compiled = dialect.sqlToQuery(query)
    if (compiled.sql.includes('WITH owner AS') && compiled.sql.includes('operator_card_confirmed')) {
      claims++
      const [before] = await h.sql`SELECT status, confirmation_expires_at > now() AS valid
        FROM sac_operator_jobs WHERE id=${id}`
      assert.deepEqual(before, { status: 'aguardando_confirmacao', valid: true })
      // A leitura e as validações do confirmJob já passaram. Só o prazo muda;
      // a instrução real do produto ainda será executada pelo Postgres.
      await h.sql`UPDATE sac_operator_jobs SET confirmation_expires_at=now()-interval '1 second' WHERE id=${id}`
    }
    return execute(query)
  })
  let result: Awaited<ReturnType<QaHarness['call']>>
  try { result = await h.call('confirm', id, input) } finally { spy.mock.restore() }
  assert.equal(claims, 1, 'O CAS real precisa ser alcançado')
  assert.equal(result.status, 410, JSON.stringify(result.body))
  assert.equal(result.body.code, 'CONFIRMATION_EXPIRED')
  assert.deepEqual((await h.sql`SELECT is_active,mode,enabled_at FROM instagram_story_automations WHERE id=${ruleId}`)[0],
    { is_active: false, mode: 'observe', enabled_at: null })
  const [job] = await h.sql`SELECT approved_plan_hash,confirmed_by,confirmed_at FROM sac_operator_jobs WHERE id=${id}`
  assert.deepEqual(job, { approved_plan_hash: null, confirmed_by: null, confirmed_at: null })
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_audit_events WHERE type='operator_card_confirmed' AND reference_id=${id}`)[0].n, 0)
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_actions WHERE job_id=${id} AND status='concluido'`)[0].n, 0)
  // Mesmo fluxo e mesma regra, com um novo cartão válido, devem funcionar.
  const valid = await activate(ruleId, 'envio')
  assert.equal((await h.call('confirm', valid.body.job.id, await confirmation(valid.body.job.id))).status, 200)
  assert.deepEqual((await h.sql`SELECT is_active,mode FROM instagram_story_automations WHERE id=${ruleId}`)[0], { is_active: true, mode: 'send' })
})

test('F3-R2-Q36 função: palavra literal válida não substitui marcador humano', async () => {
  const { palavraDoMarcador, validarPalavra } = await import('../src/lib/operator/acoes/validate')
  const markers = new Map([['[PALAVRA_1]', 'CADERNO']])
  assert.equal(validarPalavra('CADERNO'), 'CADERNO')
  assert.equal(palavraDoMarcador('[PALAVRA_1]', markers), 'CADERNO')
  assert.throws(() => palavraDoMarcador('CADERNO', markers), { code: 'MARKER_REQUIRED', status: 400 })
})

test('F3-R2-Q36 fluxo: plano forjado com palavra literal válida é recusado', async () => {
  plan([story('CADERNO')])
  const result = await h.post('Crie regra de story palavra CADERNO mensagem https://example.test/x')
  assert.equal(result.status, 400, JSON.stringify(result.body))
  assert.equal(result.body.code, 'MARKER_REQUIRED')
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_story_automations`)[0].n, 0)
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_actions WHERE status='concluido'`)[0].n, 0)
  await createStory()
})

for (const offset of [-1000, 1000]) {
  test(`F3-R2-Q42: Desfazer em 7 dias ${offset < 0 ? 'menos' : 'mais'} 1 segundo`, async () => {
    const lead = await h.lead(h.A.id, 'Fronteira temporal', 'qualificado')
    plan([{ type: 'mover_etapa', lead: '[T1]', etapa: 'agendado' }])
    const moved = await h.post(`Mova #${lead} para agendado`)
    assert.equal(moved.body.job.status, 'concluido', JSON.stringify(moved.body))
    const [action] = await h.execute.acoesDoJob(h.A.id, moved.body.job.id)
    const now = Date.now()
    // Oráculo fixo de sete dias, independente da constante que será mutada.
    const finishedAt = new Date(now - (7 * 86400000 + offset))
    await h.sql`UPDATE sac_operator_jobs SET finished_at=${finishedAt.toISOString()}::timestamptz WHERE id=${moved.body.job.id}`
    const clock = mock.method(Date, 'now', () => now)
    let result: Awaited<ReturnType<QaHarness['call']>>
    try { result = await h.call('undo', action.id) } finally { clock.mock.restore() }
    const [state] = await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=${lead}`
    if (offset < 0) {
      assert.equal(result.status, 202, JSON.stringify(result.body))
      assert.equal(result.body.job.status, 'concluido')
      assert.equal(state.pipeline_stage, 'qualificado')
    } else {
      assert.equal(result.status, 409, JSON.stringify(result.body))
      assert.equal(result.body.code, 'UNDO_WINDOW')
      assert.equal(state.pipeline_stage, 'agendado')
      assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_jobs WHERE idempotency_key=${`undo:${action.id}`}`)[0].n, 0)
    }
  })
}

test('F3-R2-Q22 fluxo: story aceita 1.000 bytes e recusa 1.001 com acentos e emoji', async () => {
  const prefix = 'https://example.test/'
  const message = prefix + 'á😀'.repeat(160) + 'x'.repeat(1000 - Buffer.byteLength(prefix) - 960)
  assert.equal(Buffer.byteLength(message), 1000)
  assert.ok(message.length < 1000)
  plan([story()])
  const accepted = await h.post(`Crie regra de story palavra CADERNO mensagem ${message}`)
  assert.equal(accepted.body.job.status, 'concluido', JSON.stringify(accepted.body))
  assert.equal((await h.sql`SELECT dm_message FROM instagram_story_automations`)[0].dm_message, message)
  assert.equal(Buffer.byteLength(message + 'x'), 1001)
  const rejected = await h.post(`Crie regra de story palavra OUTRAPALAVRA mensagem ${message}x`)
  assert.equal(rejected.status, 400, JSON.stringify(rejected.body))
  assert.equal(rejected.body.code, 'INVALID_MESSAGE')
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_story_automations`)[0].n, 1)
})
