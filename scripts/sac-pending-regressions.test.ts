import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'
import { createSacPendingRuleStore, evaluateSacPendingRules, sacRuleReconciliationSql, sacSqlRows } from '../src/lib/sac-pending-rules'
import { followupDayKey, followupDayToIso } from '../src/lib/sac-followup-date'
import { effectivePipelineStageSql, pipelineColumnsUpdateSql } from '../src/lib/pipeline-columns-update'
import { inferPipelineStage } from '../src/lib/pipeline-stage'

// Disposable PostgreSQL WASM. No DATABASE_URL/network/production state is used.
const modulePath = process.env.PGLITE_MODULE || '@electric-sql/pglite'
async function fixture() {
  const { PGlite } = await import(modulePath)
  const pg = new PGlite()
  await pg.exec(`
    CREATE TABLE companies (id serial PRIMARY KEY);
    CREATE TABLE settings (id serial PRIMARY KEY, company_id integer UNIQUE REFERENCES companies(id), pipeline_columns jsonb, updated_at timestamp DEFAULT NOW());
    CREATE TABLE company_members (id serial PRIMARY KEY, company_id integer REFERENCES companies(id), stack_auth_user_id text);
    CREATE TABLE recovery_leads (id serial PRIMARY KEY, company_id integer REFERENCES companies(id), phone text, status text,
      pipeline_stage text, event_type text, priority integer, follow_up_date timestamp, follow_up_note text,
      bot_paused_at timestamp, updated_at timestamp DEFAULT NOW());
    CREATE TABLE whatsapp_messages (id serial PRIMARY KEY, company_id integer REFERENCES companies(id), lead_id integer REFERENCES recovery_leads(id));
  `)
  for (const path of ['drizzle/0029_sac_lote1_core.sql', 'drizzle/0030_sac_lote1_reconciliation.sql']) await pg.exec(await readFile(resolve(path), 'utf8'))
  await pg.exec(`INSERT INTO companies VALUES (1),(2); INSERT INTO settings(company_id) VALUES (1),(2); INSERT INTO company_members(company_id,stack_auth_user_id) VALUES (1,'owner');`)
  const database = drizzle(pg)
  const store = createSacPendingRuleStore(database)
  const evaluate = (companyId = 1, now = '2026-10-08T15:00:00-03:00') => evaluateSacPendingRules({ companyId, now: new Date(now) }, store)
  return { pg, database, store, evaluate }
}

async function main() {
await test('date-only values use the Pipeline convention and do not expire on the chosen local day', async () => {
  assert.equal(followupDayToIso('2026-10-08'), '2026-10-08T15:00:00.000Z')
  assert.equal(followupDayKey(new Date('2026-10-08T02:15:00Z')), '2026-10-07')
  assert.throws(() => followupDayToIso('2026-02-30'))
  const f = await fixture()
  try {
    await f.pg.query(`INSERT INTO recovery_leads(company_id,phone,follow_up_date) VALUES (1,'a',$1)`, [followupDayToIso('2026-10-08')])
    assert.equal((await f.evaluate(1, '2026-10-07T23:15:00-03:00')).retornosVencidosCriados, 0)
    assert.equal((await f.evaluate(1, '2026-10-08T23:59:00-03:00')).retornosVencidosCriados, 0)
    assert.equal((await f.evaluate(1, '2026-10-09T00:01:00-03:00')).retornosVencidosCriados, 1)
    assert.equal((await f.evaluate(1, '2026-10-09T00:02:00-03:00')).retornosVencidosCriados, 0)
  } finally { await f.pg.close() }
})

await test('company reconciliation closes transbordo/stage alerts; acknowledgment and a new episode stay distinct', async () => {
  const f = await fixture()
  try {
    await f.pg.exec(`
      INSERT INTO recovery_leads(company_id,phone,sac_case_state,updated_at) VALUES (1,'handoff','transbordo','2026-10-08 02:00:00.123456');
      INSERT INTO recovery_leads(company_id,phone,sac_case_state) VALUES (2,'other-tenant','transbordo');
      INSERT INTO recovery_leads(company_id,phone,sac_case_state,bot_paused_at) VALUES (1,'paused-only','aberto',NOW());
    `)
    assert.equal((await f.evaluate()).transbordosCriados, 1)
    assert.equal((await f.evaluate()).transbordosCriados, 0)
    assert.equal((await f.pg.query('SELECT count(*)::int AS n FROM sac_pending_items WHERE company_id=2')).rows[0].n, 0)
    await f.pg.exec(`UPDATE recovery_leads SET human_owner_member_id=1,sac_case_state='em_atendimento',updated_at=NOW() WHERE id=1;`)
    assert.equal((await f.evaluate()).itensEncerrados, 1)
    await f.pg.exec(`UPDATE recovery_leads SET human_owner_member_id=NULL,sac_case_state='transbordo',sac_case_episode=sac_case_episode+1,updated_at=NOW() WHERE id=1;`)
    assert.equal((await f.evaluate()).transbordosCriados, 1)
    await f.pg.exec(`UPDATE sac_pending_items SET state='descartado',resolved_at=NOW() WHERE company_id=1 AND state='pendente';`)
    assert.equal((await f.evaluate()).transbordosCriados, 0)
    // Resolve and reopen between two cron evaluations: episode is the durable signal.
    await f.pg.exec(`UPDATE recovery_leads SET sac_case_episode=sac_case_episode+1,updated_at=NOW() WHERE id=1;`)
    assert.equal((await f.evaluate()).transbordosCriados, 1)
    assert.equal((await f.evaluate(2)).transbordosCriados, 1)
  } finally { await f.pg.close() }
})

await test('stage rule is opt-in, uses the existing fallback/custom stages, and closes after scheduling/changing stage', async () => {
  const f = await fixture()
  try {
    await f.pg.exec(`INSERT INTO recovery_leads(company_id,phone,event_type) VALUES (1,'pix-lead','pix');`)
    assert.equal((await f.evaluate()).etapasSemRetornoCriadas, 0)
    await f.pg.exec(`UPDATE settings SET sac_followup_stage_ids='["qualificado"]' WHERE company_id=1;`)
    assert.equal((await f.evaluate()).etapasSemRetornoCriadas, 1)
    await f.pg.query(`UPDATE recovery_leads SET follow_up_date=$1,updated_at=NOW() WHERE id=1`, [followupDayToIso('2026-10-09')])
    assert.equal((await f.evaluate()).itensEncerrados, 1)
    await f.pg.exec(`UPDATE recovery_leads SET follow_up_date=NULL,updated_at=NOW() WHERE id=1;`)
    assert.equal((await f.evaluate()).etapasSemRetornoCriadas, 1)
    await f.pg.exec(`UPDATE recovery_leads SET pipeline_stage='fechado',updated_at=NOW() WHERE id=1;`)
    assert.equal((await f.evaluate()).itensEncerrados, 1)
    await f.pg.exec(`UPDATE settings SET pipeline_columns='[{"id":"proposta"}]',sac_followup_stage_ids='["proposta"]' WHERE company_id=1;
      UPDATE recovery_leads SET pipeline_stage='proposta',updated_at=NOW() WHERE id=1;`)
    assert.equal((await f.evaluate()).etapasSemRetornoCriadas, 1)
    await f.pg.exec(`UPDATE recovery_leads SET sac_case_state='resolvido',updated_at=NOW() WHERE id=1;`)
    assert.equal((await f.evaluate()).itensEncerrados, 1)
  } finally { await f.pg.close() }
})

await test('full return identity creates a fresh episode after rescheduling; stale microsecond snapshots cannot write alerts', async () => {
  const f = await fixture()
  try {
    await f.pg.exec(`INSERT INTO recovery_leads(company_id,phone,follow_up_date,updated_at)
      VALUES (1,'overdue','2026-10-07 15:00:00','2026-10-08 02:00:00.123456');`)
    assert.equal((await f.evaluate()).retornosVencidosCriados, 1)
    const [snapshot] = await f.store.loadLeads(1)
    assert.equal(snapshot.updatedAt, '2026-10-08 02:00:00.123456')
    await f.pg.exec(`UPDATE recovery_leads SET follow_up_date='2026-10-07 16:00:00',updated_at='2026-10-08 02:00:00.123457' WHERE id=1;`)
    const [result] = sacSqlRows(await f.database.execute(sacRuleReconciliationSql({
      companyId: 1, leadId: 1, ruleType: 'transbordo_sem_dono', active: true, fingerprint: 'stale', reason: 'stale',
      ownerId: null, dueAt: null, leadUpdatedAt: snapshot.updatedAt, now: new Date('2026-10-08T15:00:00Z'),
    })))
    assert.equal(Number(result.created), 0)
    const rescheduled = await f.evaluate()
    assert.equal(rescheduled.retornosVencidosCriados, 1)
    assert.equal(rescheduled.itensEncerrados, 1)
  } finally { await f.pg.close() }
})

await test('column migration respects stage precedence and commercial status, bumps context, and rejects stale settings', async () => {
  const f = await fixture()
  try {
    const columns = ['a','b','c'].map(id => ({ id, label: id, color: '#333' }))
    await f.pg.query(`UPDATE settings SET pipeline_columns=$1::jsonb,sac_followup_stage_ids='["a","c"]' WHERE company_id=1`, [JSON.stringify(columns)])
    await f.pg.exec(`INSERT INTO recovery_leads(company_id,phone,pipeline_stage,status) VALUES (1,'a-lead','a','converted'),(1,'c-lead','c','a'),(2,'other','a','converted');`)
    const next = columns.filter(c => c.id !== 'a')
    const [result] = sacSqlRows(await f.database.execute(pipelineColumnsUpdateSql(1,next,'a','b',columns)))
    assert.equal(result.migrated, 1)
    const rows = (await f.pg.query(`SELECT pipeline_stage,status,context_version FROM recovery_leads ORDER BY id`)).rows
    assert.deepEqual(rows, [{ pipeline_stage:'b',status:'converted',context_version:2 },{ pipeline_stage:'c',status:'a',context_version:1 },{ pipeline_stage:'a',status:'converted',context_version:1 }])
    const [stale] = sacSqlRows(await f.database.execute(pipelineColumnsUpdateSql(1,columns.filter(c=>c.id!=='b'),'b','a',columns)))
    assert.equal(stale.saved, 0); assert.equal(stale.migrated, 0)
    assert.deepEqual((await f.pg.query(`SELECT sac_followup_stage_ids FROM settings WHERE company_id=1`)).rows[0].sac_followup_stage_ids, ['c'])
    await f.pg.exec(`UPDATE recovery_leads SET pipeline_stage='c' WHERE id=1;`)
    const [second] = sacSqlRows(await f.database.execute(pipelineColumnsUpdateSql(1,next.filter(c=>c.id!=='b'),'b','c',next)))
    assert.equal(second.migrated, 0)
  } finally { await f.pg.close() }
})

await test('column migration and configuration roll back together on a real SQL failure; SQL fallback matches JS', async () => {
  const f = await fixture()
  try {
    const columns = [{ id:'a',label:'A',color:'#333' },{ id:'b',label:'B',color:'#333' }]
    await f.pg.query(`UPDATE settings SET pipeline_columns=$1::jsonb WHERE company_id=1`, [JSON.stringify(columns)])
    await f.pg.exec(`INSERT INTO recovery_leads(company_id,phone,pipeline_stage) VALUES (1,'a-lead','a');
      CREATE FUNCTION stop_migration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced migration failure'; END $$;
      CREATE TRIGGER stop_migration BEFORE UPDATE ON recovery_leads FOR EACH ROW EXECUTE FUNCTION stop_migration();`)
    await assert.rejects(() => f.database.execute(pipelineColumnsUpdateSql(1,[columns[1]],'a','b',columns)), error =>
      error instanceof Error && error.cause instanceof Error && error.cause.message.includes('forced migration failure'))
    assert.deepEqual((await f.pg.query('SELECT pipeline_columns FROM settings WHERE company_id=1')).rows[0].pipeline_columns, columns)
    assert.equal((await f.pg.query('SELECT pipeline_stage FROM recovery_leads WHERE id=1')).rows[0].pipeline_stage, 'a')
    await f.pg.exec('DROP TRIGGER stop_migration ON recovery_leads;')
    const cases = [{pipelineStage:'custom',status:'converted'},{status:'converted'},{eventType:'compra_aprovada'},{status:'in_progress'},{eventType:'pix'},{eventType:'boleto'},{priority:2},{}]
    for (const input of cases) {
      const rows = sacSqlRows(await f.database.execute(sql`SELECT ${effectivePipelineStageSql()} AS stage FROM (
        SELECT ${'pipelineStage' in input ? input.pipelineStage : null}::text AS pipeline_stage,
          ${'status' in input ? input.status : null}::text AS status,
          ${'eventType' in input ? input.eventType : null}::text AS event_type,
          ${'priority' in input ? input.priority : null}::int AS priority
      ) AS lead`))
      assert.equal(rows[0].stage, inferPipelineStage(input))
    }
  } finally { await f.pg.close() }
})

await test('hundreds of actual leads reconcile in bounded SQL batches without N+1 requests or duplicate alerts', async () => {
  const f=await fixture()
  try {
    await f.pg.exec(`INSERT INTO recovery_leads(company_id,phone,follow_up_date)
      SELECT 1,'batch-' || n::text,'2026-10-07 15:00:00'::timestamp FROM generate_series(1,200) n;`)
    let requests=0
    const countedStore=createSacPendingRuleStore({ execute(query) { requests++;return f.database.execute(query) } })
    const options={ companyId:1,now:new Date('2026-10-08T15:00:00-03:00') }
    assert.equal((await evaluateSacPendingRules(options,countedStore)).retornosVencidosCriados,200)
    assert.equal(requests,4) // policy + leads + two bounded reconciliation batches
    requests=0
    assert.equal((await evaluateSacPendingRules(options,countedStore)).retornosVencidosCriados,0)
    assert.equal(requests,4)
    assert.equal((await f.pg.query('SELECT count(*)::int AS n FROM sac_pending_items')).rows[0].n,200)
  } finally { await f.pg.close() }
})
}
main().catch(error => { console.error(error); process.exitCode=1 })
