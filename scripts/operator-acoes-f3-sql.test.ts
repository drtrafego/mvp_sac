/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, test } from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import { createOperatorAcoesHarness, type QaHarness } from './operator-acoes-harness'
import type { PreparedAction } from '../src/lib/operator/acoes/types'
let h: QaHarness
const dialect = new PgDialect()
before(async () => { h = await createOperatorAcoesHarness() })
after(async () => { if (h) await h.close() })
beforeEach(async () => {
  h.fresh()
  await h.sql`DELETE FROM instagram_story_deliveries`
  await h.sql`DELETE FROM instagram_story_automations`
  await h.sql`DELETE FROM sac_operator_actions`
  await h.sql`DELETE FROM sac_operator_jobs`
  await h.sql`DELETE FROM sac_operator_locks`
  await h.sql`UPDATE sac_operator_company_settings SET enabled=true,kill_switch=false,allowed_actions='["criar_regra_story","editar_regra_story","ativar_regra_story","desativar_regra_story","mover_etapa_lote"]'`
})
function directSql(text: string, params: unknown[]) {
  const values: any[] = []
  const command = text.replace(/\$(\d+)(::jsonb)?/g, (_, n, cast) => { const value = params[Number(n) - 1]; values.push(cast && typeof value === 'string' ? JSON.parse(value) : value); return `$${values.length}${cast ?? ''}` })
  return h.sql.unsafe(command, values)
}
async function prepared() {
  return h.prepared([{ type:'criar_regra_story',palavra:'[PALAVRA_1]',mensagem:'[LINK_1]',correspondencia:'contem',ativar:'nao' }], 'Crie story palavra CADERNO mensagem https://example.test/material')
}

test('F3-GATE: cada trava SQL isolada impede story sem depender da rota', async () => {
  const { gate } = await import('../src/lib/operator/acoes/sql')
  const { adquirirTrava } = await import('../src/lib/operator/acoes/lock')
  const p = await prepared(); const a = p.actions[0]
  const holder = randomUUID(); assert.equal(await adquirirTrava(h.A.id,holder),true)
  const check = async (action: PreparedAction = a, owner = holder, companyId = h.A.id) => {
    const q = dialect.sqlToQuery(gate({...h.actor(),companyId}, action, owner))
    return (await directSql(q.sql,q.params)).length
  }
  assert.equal(await check(),1,'Controle positivo')
  await h.sql`UPDATE sac_operator_company_settings SET enabled=false WHERE company_id=${h.A.id}`
  assert.equal(await check(),0,'enabled isolado')
  await h.sql`UPDATE sac_operator_company_settings SET enabled=true,kill_switch=true WHERE company_id=${h.A.id}`
  assert.equal(await check(),0,'kill isolado')
  await h.sql`UPDATE sac_operator_company_settings SET kill_switch=false,allowed_actions='[]' WHERE company_id=${h.A.id}`
  assert.equal(await check(),0,'permissão isolada')
  await h.sql`UPDATE sac_operator_company_settings SET allowed_actions='["criar_regra_story"]' WHERE company_id=${h.A.id}`
  assert.equal(await check(),1)
  assert.equal(await check(a,randomUUID()),0,'holder isolado')
  await h.sql`UPDATE sac_operator_locks SET locked_until=now()-interval '1 second' WHERE company_id=${h.A.id}`
  assert.equal(await check(),0,'prazo do lock isolado')
  await h.sql`UPDATE sac_operator_locks SET locked_until=now()+interval '1 minute' WHERE company_id=${h.A.id}`
  await h.sql`UPDATE sac_operator_locks SET company_id=${h.B.id} WHERE company_id=${h.A.id}`
  assert.equal(await check(),0,'empresa do lock isolada')
  await h.sql`UPDATE sac_operator_locks SET company_id=${h.A.id} WHERE company_id=${h.B.id}`
  assert.equal(await check(a,holder,h.B.id),0,'empresa do gate isolada')
  await h.sql`UPDATE sac_operator_jobs SET company_id=${h.B.id} WHERE id=${p.jobId}`
  assert.equal(await check(),0,'empresa do job isolada')
  await h.sql`UPDATE sac_operator_jobs SET company_id=${h.A.id} WHERE id=${p.jobId}`
  await h.sql`UPDATE sac_operator_actions SET company_id=${h.B.id} WHERE id=${a.id}`
  assert.equal(await check(),0,'empresa da ação isolada')
  await h.sql`UPDATE sac_operator_actions SET company_id=${h.A.id} WHERE id=${a.id}`
  await h.sql`UPDATE sac_operator_jobs SET status='concluido' WHERE id=${p.jobId}`
  assert.equal(await check(),0,'estado do job isolado')
  await h.sql`UPDATE sac_operator_jobs SET status='em_execucao' WHERE id=${p.jobId}`
  await h.sql`UPDATE sac_operator_actions SET status='concluido' WHERE id=${a.id}`
  assert.equal(await check(),0,'estado da ação isolado')
  await h.sql`UPDATE sac_operator_actions SET status='pendente' WHERE id=${a.id}`
  const card = {...a,requestJson:{...a.requestJson,execucao:'cartao' as const}}
  await h.sql`UPDATE sac_operator_jobs SET plan_hash='hash',approved_plan_hash='outro',confirmed_by='admin' WHERE id=${p.jobId}`
  assert.equal(await check(card),0,'hash aprovado isolado')
  await h.sql`UPDATE sac_operator_jobs SET approved_plan_hash=plan_hash,confirmed_by=NULL WHERE id=${p.jobId}`
  assert.equal(await check(card),0,'confirmador isolado')
  await h.sql`UPDATE sac_operator_jobs SET confirmed_by='admin' WHERE id=${p.jobId}`
  assert.equal(await check(card),1,'Cartão autorizado tem controle positivo')
})

function cte(query: string, name: string) {
  const start = query.indexOf(`${name} AS (`)
  assert.notEqual(start,-1,`CTE ${name} deve existir`)
  let depth = 1, quote = false
  const begin = start + `${name} AS (`.length
  for (let i=begin;i<query.length;i++) {
    if (query[i] === "'") { if (quote && query[i+1] === "'") { i++; continue } quote=!quote }
    if (!quote && query[i]==='(') depth++
    if (!quote && query[i]===')' && --depth===0) return query.slice(begin,i)
  }
  throw new Error(`CTE ${name} incompleta`)
}

test('F3-SQL-TENANT: story UPDATE DELETE recibo e INSERT isolam empresa sem gate redundante', async () => {
  const { regraStorySql } = await import('../src/lib/operator/acoes/sql')
  const p = await prepared(); const base=p.actions[0]; const actor=h.actor()
  const [foreign] = await h.sql`INSERT INTO instagram_story_automations (company_id,name,keywords,dm_message) VALUES (${h.B.id},'Alheia',ARRAY['PRIVADA'],'Preservar') RETURNING id,updated_at::text,created_at::text`
  const foreignAction={...base,ordinal:2,id:randomUUID(),companyId:h.B.id,idempotencyKey:randomUUID()}
  const { sacOperatorActions } = await import('../src/lib/operator/schema')
  await h.db.insert(sacOperatorActions).values(foreignAction)
  const snapshot = async () => JSON.stringify({rules:await h.sql`SELECT to_jsonb(r) v FROM instagram_story_automations r ORDER BY id`,actions:await h.sql`SELECT to_jsonb(r) v FROM sac_operator_actions r ORDER BY id`})
  const before=await snapshot()
  const target={...base.requestJson.regra!,id:foreign.id,updated_at:foreign.updated_at,created_at:foreign.created_at}
  const forged={...base,beforeSnapshot:{regra:target},requestJson:{...base.requestJson,regra:{...target,is_active:true,mode:'send'}}}
  for(const type of ['ativar_regra_story','desfazer_criar_regra_story']) {
    const q=dialect.sqlToQuery(regraStorySql(actor,{...forged,actionType:type},randomUUID(),10000))
    assert.equal((await directSql(`WITH gate AS (SELECT 1) ${cte(q.sql,'eff')}`,q.params)).length,0,`${type} protege empresa própria`)
    assert.equal(await snapshot(),before)
  }
  const q=dialect.sqlToQuery(regraStorySql(actor,{...base,id:foreignAction.id},randomUUID(),10000,foreign.id+1))
  assert.equal((await directSql(`WITH gate AS (SELECT 1) ${cte(q.sql,'clm')}`,q.params)).length,0,'claim próprio filtra empresa')
  assert.equal(await snapshot(),before)
  const update=dialect.sqlToQuery(regraStorySql(actor,{...forged,id:foreignAction.id,actionType:'ativar_regra_story'},randomUUID(),10000))
  assert.equal((await directSql(`WITH eff AS (SELECT * FROM instagram_story_automations WHERE id=${foreign.id}) ${cte(update.sql,'rec')}`,update.params)).length,0,'recibo UPDATE próprio filtra empresa')
  assert.equal(await snapshot(),before)
  // Controle positivo e origem da empresa no INSERT, sem gate/claim externos.
  for(const companyId of [h.A.id,h.B.id]) {
    const id=(await h.sql`SELECT nextval('instagram_story_automations_id_seq')::int id`)[0].id
    const insert=dialect.sqlToQuery(regraStorySql({...actor,companyId},base,randomUUID(),100000,id))
    const rows=await directSql(`WITH clm AS (SELECT 1) ${cte(insert.sql,'eff')}`,insert.params)
    assert.equal(rows.length,1)
    assert.equal(rows[0].company_id,companyId,'INSERT usa empresa da sessão')
    const audit=dialect.sqlToQuery(regraStorySql({...actor,companyId},base,randomUUID(),100000,id))
    const audits=await directSql(`WITH eff AS (SELECT * FROM instagram_story_automations WHERE id=${id}) ${cte(audit.sql,'aud')}`,audit.params)
    const row=(await h.sql`SELECT company_id FROM sac_audit_events WHERE id=${audits[0].id}`)[0]
    assert.equal(row.company_id,companyId,'INSERT da auditoria usa empresa da sessão')
  }
})

test('F3-SQL-CAS: guarda SQL story funciona mesmo sem releitura TS', async () => {
  const { regraStorySql } = await import('../src/lib/operator/acoes/sql')
  const p=await prepared(); const a=p.actions[0]
  const [row]=await h.sql`INSERT INTO instagram_story_automations (company_id,name,keywords,dm_message) VALUES (${h.A.id},'CAS',ARRAY['CADERNO'],'Mensagem') RETURNING id, updated_at::text,created_at::text`
  const target={...a.requestJson.regra!,id:row.id,updated_at:row.updated_at,created_at:row.created_at}
  const change={...a,actionType:'ativar_regra_story',beforeSnapshot:{regra:target},requestJson:{...a.requestJson,regra:{...target,is_active:true,mode:'send'}}}
  await h.sql`UPDATE instagram_story_automations SET updated_at=updated_at+interval '1 second' WHERE id=${row.id}`
  const q=dialect.sqlToQuery(regraStorySql(h.actor(),change,randomUUID(),100000))
  assert.equal((await directSql(`WITH gate AS (SELECT 1) ${cte(q.sql,'eff')}`,q.params)).length,0,'CAS própria no UPDATE')
  assert.equal((await h.sql`SELECT is_active FROM instagram_story_automations WHERE id=${row.id}`)[0].is_active,false)
})

test('F3-SQL-RACE: INSERT story recusa regra nova da mesma empresa desde a validação', async () => {
  const { regraStorySql } = await import('../src/lib/operator/acoes/sql')
  const p=await prepared(); const a=p.actions[0]
  const [row]=await h.sql`INSERT INTO instagram_story_automations (company_id,name,keywords,dm_message) VALUES (${h.A.id},'Painel',ARRAY['CADERNO'],'Mensagem') RETURNING id`
  const id=(await h.sql`SELECT nextval('instagram_story_automations_id_seq')::int id`)[0].id
  const q=dialect.sqlToQuery(regraStorySql(h.actor(),a,randomUUID(),row.id-1,id))
  assert.equal((await directSql(`WITH clm AS (SELECT 1) ${cte(q.sql,'eff')}`,q.params)).length,0)
  const other=dialect.sqlToQuery(regraStorySql({...h.actor(),companyId:h.B.id},a,randomUUID(),row.id-1,id))
  assert.equal((await directSql(`WITH clm AS (SELECT 1) ${cte(other.sql,'eff')}`,other.params)).length,1,'Regra nova alheia não bloqueia INSERT')
})

test('F3-SQL-ATOM: recibo e auditoria story falhando revertem INSERT e UPDATE', async () => {
  await h.sql.unsafe(`CREATE OR REPLACE FUNCTION qa_f3_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type LIKE 'operator_story_rule_%' THEN RETURN NULL; END IF; RETURN NEW; END $$`)
  await h.sql`CREATE TRIGGER qa_f3_reject_audit BEFORE INSERT ON sac_audit_events FOR EACH ROW EXECUTE FUNCTION qa_f3_reject_audit()`
  try {
    const p=await prepared()
    const result=await h.execute.executarJob(h.actor(),p.jobId)
    assert.equal(result[0].afterSnapshot?.erro,'OPERATOR_INCONSISTENT')
    assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_story_automations`)[0].n,0)
    const [row]=await h.sql`INSERT INTO instagram_story_automations (company_id,name,keywords,dm_message,is_active,mode) VALUES (${h.A.id},'Intacta',ARRAY['OUTRAPALAVRA'],'Mensagem',true,'send') RETURNING id`
    const before=(await h.sql`SELECT to_jsonb(r) v FROM instagram_story_automations r WHERE id=${row.id}`)[0].v
    const change=await h.prepared([{type:'desativar_regra_story',regra:`#${row.id}`}],`Desative story #${row.id}`)
    const result2=await h.execute.executarJob(h.actor(),change.jobId)
    assert.equal(result2[0].afterSnapshot?.erro,'OPERATOR_INCONSISTENT')
    assert.deepEqual((await h.sql`SELECT to_jsonb(r) v FROM instagram_story_automations r WHERE id=${row.id}`)[0].v,before)
  } finally {
    await h.sql`DROP TRIGGER qa_f3_reject_audit ON sac_audit_events`
    await h.sql`DROP FUNCTION qa_f3_reject_audit()`
  }
})

test('F3-BATCH-SQL: UPDATE isolado exige empresa, valor e versão mesmo com eligible autorizado', async () => {
  const { loteSql }=await import('../src/lib/operator/acoes/batch')
  const p=await prepared(); const base=p.actions[0]
  const own=await h.lead(h.A.id,'Sentinela lote','qualificado')
  const foreign=await h.lead(h.B.id,'Sentinela outra','qualificado')
  const action={...base,actionType:'mover_etapa_lote',requestJson:{...base.requestJson,lote:[{id:own,pipelineStage:'qualificado',contextVersion:1,etapaEfetiva:'qualificado'}],etapaOrigem:'qualificado',etapaDestino:'agendado'}}
  const q=dialect.sqlToQuery(loteSql(h.actor(),action,randomUUID()))
  const run=(id:number,stage:string,version:number)=>directSql(`WITH eligible AS (SELECT ${id}::int id,'${stage}'::text pipeline_stage,${version}::int context_version,NULL::text before_pipeline_stage),gate_batch AS(SELECT 1) ${cte(q.sql,'eff')}`,q.params)
  assert.equal((await run(foreign,'qualificado',1)).length,0,'UPDATE tenant próprio')
  assert.equal((await run(own,'novo_contato',1)).length,0,'UPDATE valor próprio')
  assert.equal((await run(own,'qualificado',2)).length,0,'UPDATE versão própria')
  assert.equal((await run(own,'qualificado',1)).length,1,'controle positivo UPDATE')
  assert.equal((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=${foreign}`)[0].pipeline_stage,'qualificado')
})

test('F3-BATCH-TENANT: recibo e auditoria próprios e snapshot sem leitura TS', async () => {
  const { loteSql } = await import('../src/lib/operator/acoes/batch')
  const p = await prepared(); const base = p.actions[0]
  const foreign = await h.lead(h.B.id,'Sentinela estrangeira','qualificado')
  const action = {...base, actionType:'mover_etapa_lote',requestJson:{...base.requestJson,lote:[{id:foreign,pipelineStage:'qualificado',contextVersion:1,etapaEfetiva:'qualificado'}],etapaDestino:'agendado'}}
  const q = dialect.sqlToQuery(loteSql(h.actor(),action,randomUUID()))
  assert.equal((await directSql(`WITH snap AS (${cte(q.sql,'snap')}) ${cte(q.sql,'tenant_ok')}`,q.params)).length,0,'snapshot alheio sem precheck TS')
  await h.sql`UPDATE sac_operator_actions SET company_id=${h.B.id} WHERE id=${base.id}`
  const eff=`SELECT ${foreign}::int id,'qualificado'::text before_pipeline_stage,1::int before_context_version,'agendado'::text pipeline_stage,2::int context_version`
  assert.equal((await directSql(`WITH gate_batch AS(SELECT 1),snap AS (${cte(q.sql,'snap')}),eff AS (${eff}) ${cte(q.sql,'rec')}`,q.params)).length,0,'tenant do recibo sem gate redundante')
  for (const companyId of [h.A.id,h.B.id]) {
    const audit = dialect.sqlToQuery(loteSql({...h.actor(),companyId},action,randomUUID()))
    const result = await directSql(`WITH eff AS (${eff}) ${cte(audit.sql,'aud')}`,audit.params)
    assert.equal((await h.sql`SELECT company_id FROM sac_audit_events WHERE id=${result[0].id}`)[0].company_id,companyId)
  }
})

test('F3-BATCH-ATOM: auditoria suprimida reverte todo o lote e seu recibo', async () => {
  const lead = await h.lead(h.A.id,'Lote atômico','qualificado')
  const p = await h.prepared([{type:'mover_etapa_lote',etapaOrigem:'qualificado',etapaDestino:'agendado'}],'Mova qualificado para agendado')
  await h.sql.unsafe(`CREATE FUNCTION qa_f3_batch_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='context_updated' THEN RETURN NULL; END IF; RETURN NEW; END $$`)
  await h.sql`CREATE TRIGGER qa_f3_batch_audit BEFORE INSERT ON sac_audit_events FOR EACH ROW EXECUTE FUNCTION qa_f3_batch_audit()`
  try {
    const [result] = await h.execute.executarJob(h.actor(),p.jobId)
    assert.equal(result.afterSnapshot?.erro,'OPERATOR_INCONSISTENT')
    assert.equal((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=${lead}`)[0].pipeline_stage,'qualificado')
    assert.equal((await h.sql`SELECT count(*)::int n FROM sac_audit_events WHERE reference_id=${p.actions[0].id}`)[0].n,0)
  } finally {
    await h.sql`DROP TRIGGER qa_f3_batch_audit ON sac_audit_events`
    await h.sql`DROP FUNCTION qa_f3_batch_audit()`
  }
})
