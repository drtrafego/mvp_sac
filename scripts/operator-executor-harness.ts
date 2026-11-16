/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mock } from 'node:test'
import { createOperatorAcoesHarness } from './operator-acoes-harness'
import type { ClaimResponse } from '../src/lib/operator/executor/contract'

export async function executorHarness() {
  const h = await createOperatorAcoesHarness('fila')
  await h.sql.unsafe(readFileSync('drizzle/0047_sac_operator_executor.sql', 'utf8'))
  await h.sql.unsafe(readFileSync('drizzle/0047_sac_operator_executor.sql', 'utf8'))
  const queue = await import('../src/lib/operator/executor/queue')
  const auth = await import('../src/lib/operator/executor/auth')
  const service = await import('../src/lib/operator/service')
  const heartbeat = await import('../src/app/api/operator-executor/jobs/[jobId]/heartbeat/route')
  const complete = await import('../src/app/api/operator-executor/jobs/[jobId]/complete/route')
  const fail = await import('../src/app/api/operator-executor/jobs/[jobId]/fail/route')
  const claim = await import('../src/app/api/operator-executor/claim/route')
  const status = await import('../src/app/api/operator/executor/route')
  mock.method(globalThis, 'fetch', async () => { h.externalCalls.push('saída bloqueada'); throw new Error('Rede proibida') })
  const ready = { versao: 'f1-test', estado: 'pronto' as const }
  const newExecutor = async (empresas = [h.A.id, h.B.id, h.I.id]) => {
    const token = 'sacop_' + randomBytes(32).toString('base64url'); const id = randomUUID()
    await h.sql`INSERT INTO sac_operator_executors (id,nome,token_hash,token_prefixo,empresas_permitidas) VALUES (${id},'teste',${createHash('sha256').update(token).digest('hex')},${token.slice(0,10)},${h.sql.json(empresas)})`
    return { id, empresas, token }
  }
  const executor = await newExecutor()
  const reset = async () => {
    h.fresh()
    await h.sql`TRUNCATE sac_operator_job_privados, sac_operator_queue, sac_operator_actions, sac_operator_jobs, sac_operator_locks`
    await h.sql`UPDATE sac_operator_company_settings SET enabled=true, kill_switch=false, daily_usage_date=NULL, daily_jobs_reserved=0, daily_tokens_reserved=0, daily_token_budget=1000000, max_jobs_per_day=1000`
    await h.sql`INSERT INTO company_members (company_id,stack_auth_user_id,email,role,status) VALUES (${h.A.id},${h.state.user},'qa@example.test','admin','ativo'),(${h.B.id},${h.state.user},'qa@example.test','admin','ativo'),(${h.I.id},${h.state.user},'qa@example.test','admin','ativo') ON CONFLICT DO NOTHING`
    await h.sql`UPDATE sac_operator_executors SET revogado_em=NULL, empresas_permitidas=${h.sql.json(executor.empresas)} WHERE id=${executor.id}`
  }
  const submit = async (company = h.A, text = 'Liste etapas', key = randomUUID()) => {
    h.state.company = company
    return service.createOperatorService({ planner: { tipo: 'fila' } }).submit({ companyId: company.id, userId: h.state.user, role: h.state.role, actorName: 'Admin', requestText: text, idempotencyKey: key })
  }
  const take = () => queue.reclamar(executor, ready)
  const lease = (c: ClaimResponse) => ({ executor, jobId: c.jobId, companyId: h.state.company.id, epoch: c.epoch, token: c.leaseToken })
  const body = (c: ClaimResponse, plano: unknown = { actions: [{ type: 'listar_etapas' }], response: 'ok' }) => ({ epoch: c.epoch, plano, modelo: 'gpt-5.6-luna' as const, uso: { entrada: 100, cache: 50, saida: 20 }, duracaoMs: 500 })
  const request = (data: unknown, token = executor.token, headers = {}) => new Request('https://sac.test/api/operator-executor', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) })
  const call = async (kind: 'heartbeat' | 'complete' | 'fail', c: ClaimResponse, data: unknown, headers = {}, token = executor.token) => {
    const response = await ({ heartbeat, complete, fail })[kind].POST(request(data, token, { 'x-operator-lease': c.leaseToken, ...headers }), { params: Promise.resolve({ jobId: c.jobId }) })
    return { status: response.status, body: await response.json() as any, headers: response.headers }
  }
  await reset()
  return { ...h, queue, auth, service, executor, newExecutor, reset, submit, take, lease, body, request, callExecutor: call, claim, status, ready }
}
export type ExecutorHarness = Awaited<ReturnType<typeof executorHarness>>
