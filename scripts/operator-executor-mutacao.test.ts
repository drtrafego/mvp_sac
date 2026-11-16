import assert from 'node:assert/strict'
import { before, after, beforeEach, test, mock } from 'node:test'
import { readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { SQLWrapper } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import { acaoSchema, acoesPlanSchema } from '../src/lib/operator/acoes/catalog'
import { operatorOutputSchema } from '../src/lib/operator/executor/output-schema'
import { completeBodySchema } from '../src/lib/operator/executor/contract'
import { executorHarness, type ExecutorHarness } from './operator-executor-harness'
let h: ExecutorHarness
before(async () => { h = await executorHarness() })
after(async () => { if (h) await h.close() })
beforeEach(async () => { await h.reset() })

test('T14: schema do CLI tem as mesmas 16 ações, chaves, enums e opcionais nullable', () => {
  const variants = operatorOutputSchema.properties!.actions.items!.anyOf!
  assert.equal(variants.length, 16); assert.equal(operatorOutputSchema.additionalProperties, false)
  assert.equal(operatorOutputSchema.properties!.actions.maxItems, 3)
  for (const action of acaoSchema.options) {
    const variant = variants.find(v => v.properties!.type.enum![0] === action.shape.type.value)!
    assert.ok(variant); assert.equal(variant.additionalProperties, false)
    assert.deepEqual(variant.required!.sort(), Object.keys(action.shape).sort())
    assert.deepEqual(Object.keys(variant.properties!).sort(), Object.keys(action.shape).sort())
    for (const [key, value] of Object.entries(action.shape)) {
      const field = variant.properties![key]
      if (value instanceof z.ZodOptional) assert.equal(field.anyOf![1].type, 'null')
      if (value instanceof z.ZodEnum) assert.deepEqual(field.enum, value.options)
    }
  }
  assert.equal(acoesPlanSchema.safeParse({ actions: [{ type: 'listar_etapas', companyId: 1 }], response: 'ok' }).success, false)
})
test('strict do envelope de complete é independente do parse do plano', () => {
  const base = { epoch: 1, plano: { actions: [{ type: 'listar_etapas' }], response: 'ok' }, uso: { entrada: 1, cache: 0, saida: 1 }, modelo: 'gpt-5.6-luna', duracaoMs: 10 }
  assert.equal(completeBodySchema.safeParse(base).success, true)
  assert.equal(completeBodySchema.safeParse({ ...base, empresa: h.A.id }).success, false)
  assert.equal(completeBodySchema.safeParse({ ...base, uso: { ...base.uso, extra: true } }).success, false)
})
test('kill do claim no próprio SQL: ligado depois da varredura, nenhum claim', async () => {
  await h.submit()
  const execute = h.db.execute.bind(h.db)
  const spy = mock.method(h.db, 'execute', async (query: SQLWrapper) => {
    const text = new PgDialect().sqlToQuery(query.getSQL()).sql
    if (text.includes('valid_executor AS MATERIALIZED')) await h.sql`UPDATE sac_operator_company_settings SET kill_switch=true WHERE company_id=${h.A.id}`
    return execute(query)
  })
  try { assert.equal(await h.take(), null) } finally { spy.mock.restore() }
  assert.equal((await h.sql`SELECT estado FROM sac_operator_queue`)[0].estado, 'na_fila', 'varredura não pode mascarar esta trava')
})
test('parse do plano é necessário: ação de leitura com campo extra não chega ao serviço', async () => {
  await h.submit(); const c = (await h.take())!
  const result = await h.callExecutor('complete', c, h.body(c, { actions: [{ type: 'listar_etapas', companyId: h.B.id }], response: 'ok' }))
  assert.equal(result.body.codigo, 'INVALID_PLAN')
  assert.equal((await h.sql`SELECT status FROM sac_operator_jobs WHERE id=${c.jobId}`)[0].status, 'falhou')
})
test('INSERT privado com company_id forjado aborta a instrução inteira', async () => {
  const r = await h.submit()
  await h.sql`DELETE FROM sac_operator_queue WHERE job_id=${r.job.id}`
  await h.sql`DELETE FROM sac_operator_job_privados WHERE job_id=${r.job.id}`
  await assert.rejects(h.queue.enfileirar(r.job, { job_id: r.job.id, company_id: h.B.id, marcadores: {}, texto_original: 'teste', ator_nome: 'Admin', empresa_slug: '', created_at: new Date().toISOString() }))
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_queue`)[0].n, 0)
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_job_privados`)[0].n, 0)
})
test('migração aditiva, sem FK/ALTER, nasce desligada, novas pastas sem regra por empresa', async () => {
  const migration = readFileSync('drizzle/0047_sac_operator_executor.sql', 'utf8')
  assert.doesNotMatch(migration, /\bALTER\b|REFERENCES|FOREIGN KEY/i)
  const statements = migration.replace(/--[^\n]*/g, '').split(';').filter(s => s.trim())
  assert.ok(statements.every(s => /^\s*CREATE (?:UNIQUE )?(?:TABLE|INDEX) IF NOT EXISTS/i.test(s)))
  for (const name of ['auth','queue','planner','contract','output-schema','status']) assert.doesNotMatch(readFileSync(`src/lib/operator/executor/${name}.ts`, 'utf8'), /slug|Isabela|isabela|bot_paused|botPaused|\.transaction\(/)
  await h.sql`INSERT INTO sac_operator_company_settings(company_id) VALUES (999999)`
  assert.equal((await h.sql`SELECT enabled FROM sac_operator_company_settings WHERE company_id=999999`)[0].enabled, false)
  await h.sql`DELETE FROM sac_operator_company_settings WHERE company_id=999999`
})
test('token: dry-run não gera segredo; criação, rotação e revogação locais, arquivo 600 e stdout só prefixo', async () => {
  const dir = mkdtempSync('/tmp/operator-token-'); const file = dir + '/env.sac-operator'
  const env = { ...process.env, NODE_ENV: 'test' as const, OPERATOR_TOKEN_DATABASE_URL: h.databaseUrl, OPERATOR_TOKEN_EXPECTED_DATABASE: 'test', OPERATOR_TOKEN_CONFIRM: 'sim', OPERATOR_TOKEN_NOME: 'QA', OPERATOR_TOKEN_EMPRESAS: String(h.A.id), OPERATOR_TOKEN_TEST_FILE: file }
  const run = (args: string[], extra = {}) => execFileSync('node', ['--import', 'tsx', 'scripts/operator-executor-token.ts', ...args], { env: { ...env, ...extra }, encoding: 'utf8' })
  try {
    assert.match(run(['criar']), /Dry-run/)
    const output = run(['criar', '--apply']).trim()
    const token = readFileSync(file, 'utf8').trim().split('=')[1]
    assert.equal(output, token.slice(0, 10)); assert.notEqual(output, token); assert.equal(statSync(file).mode & 0o777, 0o600)
    const [row] = await h.sql`SELECT id, token_hash FROM sac_operator_executors WHERE token_prefixo=${output}`
    assert.equal(row.token_hash, createHash('sha256').update(token).digest('hex'))
    const rotated = run(['rotacionar', '--apply'], { OPERATOR_TOKEN_ID: row.id }).trim()
    assert.notEqual(rotated, output)
    assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_executors WHERE substitui_id=${row.id} AND revogado_em IS NULL`)[0].n, 1)
    assert.equal(run(['revogar', '--apply'], { OPERATOR_TOKEN_ID: row.id }).trim(), output)
    await assert.rejects(h.auth.authenticateExecutor(h.request({}, token)), { status: 401 })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('aplicador 0047: dry-run padrão, confirmações e banco remoto incorreto recusados antes da conexão', () => {
  const run = (args: string[], env: Record<string, string> = {}) => {
    try { return { status: 0, output: execFileSync('node', ['--import', 'tsx', 'scripts/operator-apply-migration-0047.ts', ...args], { env: { ...process.env, OPERATOR_MIGRATION_CONFIRM: '', ...env }, encoding: 'utf8', stdio: 'pipe' }) } } catch (e) { return { status: (e as { status: number }).status, output: '' } }
  }
  assert.match(run([]).output, /Modo dry-run/)
  assert.equal(run(['--apply']).status, 1)
  assert.equal(run(['--apply'], { OPERATOR_MIGRATION_CONFIRM: 'sim', OPERATOR_MIGRATION_DATABASE_URL: 'postgres://postgres:test@127.0.0.1:1/errado', OPERATOR_MIGRATION_EXPECTED_DATABASE: 'test' }).status, 1)
  assert.equal(run(['--apply'], { OPERATOR_MIGRATION_CONFIRM: 'sim', OPERATOR_MIGRATION_DATABASE_URL: 'postgres://postgres:test@remote.invalid/test', OPERATOR_MIGRATION_EXPECTED_DATABASE: 'test' }).status, 1)
})
