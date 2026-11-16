import assert from 'node:assert/strict'
import { before, after, beforeEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { executorHarness, type ExecutorHarness } from './operator-executor-harness'
let h: ExecutorHarness
before(async () => { h = await executorHarness() })
after(async () => { if (h) await h.close() })
beforeEach(async () => { await h.reset() })

test('T3: vinte claims em conexões reais, um holder, empresa serial e outra prossegue', async () => {
  await h.submit(); await h.submit()
  const claims = await Promise.all(Array.from({ length: 20 }, () => h.take()))
  assert.equal(claims.filter(Boolean).length, 1)
  assert.equal(await h.take(), null)
  await h.submit(h.B)
  assert.ok(await h.take())
  await h.submit(h.I)
  assert.equal(await h.take(), null, 'máximo de dois ativos por executor')
  const pids = await Promise.all(Array.from({ length: 8 }, () => h.sql`SELECT pg_backend_pid() AS pid, pg_sleep(0.02)`))
  assert.ok(new Set(pids.map(r => r[0].pid)).size >= 2)
})
test('T2: scope vem do banco, claim não atende B com token A', async () => {
  await h.submit(h.B)
  await h.sql`UPDATE sac_operator_executors SET empresas_permitidas=${h.sql.json([h.A.id])} WHERE id=${h.executor.id}`
  assert.equal(await h.take(), null)
})
test('T4: epoch velho isolado, token velho, executor alheio e lease vencido recusam os três CAS', async () => {
  await h.submit(); const c = (await h.take())!; assert.ok(c)
  for (const bad of [{ ...h.lease(c), epoch: c.epoch + 1 }, { ...h.lease(c), token: 'x'.repeat(43) }, { ...h.lease(c), executor: await h.newExecutor() }, { ...h.lease(c), companyId: h.B.id }]) {
    await assert.rejects(h.queue.heartbeat(bad), { code: 'LEASE_CONFLICT' })
    assert.equal(await h.queue.concluirCAS(bad), null)
    await assert.rejects(h.queue.falhar(bad, { epoch: bad.epoch, codigo: 'CLI_ERROR' }), { code: 'LEASE_CONFLICT' })
  }
  await h.sql`UPDATE sac_operator_queue SET lease_expira_em=now()-interval '1 second' WHERE job_id=${c.jobId}`
  await assert.rejects(h.queue.heartbeat(h.lease(c)), { code: 'LEASE_CONFLICT' })
  assert.equal(await h.queue.concluirCAS(h.lease(c)), null)
  await assert.rejects(h.queue.falhar(h.lease(c), { epoch: c.epoch, codigo: 'CLI_ERROR' }), { code: 'LEASE_CONFLICT' })
  assert.equal((await h.sql`SELECT estado FROM sac_operator_queue WHERE job_id=${c.jobId}`)[0].estado, 'reclamado')
})
test('CAS exige prazo do job mesmo com lease futuro, sem varredura prévia', async () => {
  await h.submit(); const c = (await h.take())!
  await h.sql`UPDATE sac_operator_queue SET expira_em=now()-interval '1 second', lease_expira_em=now()+interval '45 seconds' WHERE job_id=${c.jobId}`
  assert.equal(await h.queue.concluirCAS(h.lease(c)), null)
  await assert.rejects(h.queue.heartbeat(h.lease(c)), { code: 'LEASE_CONFLICT' })
  await assert.rejects(h.queue.falhar(h.lease(c), { epoch: c.epoch, codigo: 'CLI_ERROR' }), { code: 'LEASE_CONFLICT' })
})
test('T6: kill entre claim e complete: heartbeat false, falha sem efeito', async () => {
  await h.submit(); const c = (await h.take())!
  await h.sql`UPDATE sac_operator_company_settings SET kill_switch=true WHERE company_id=${h.A.id}`
  assert.equal(await h.queue.concluirCAS(h.lease(c)), null)
  assert.deepEqual(await h.queue.heartbeat(h.lease(c)), { continuar: false })
  assert.equal((await h.sql`SELECT status FROM sac_operator_jobs WHERE id=${c.jobId}`)[0].status, 'falhou')
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_job_privados`)[0].n, 0)
})
test('T7: cinco na fila, sexta devolve reserva; trinta pedidos respeitam cota', async () => {
  for (let i = 0; i < 5; i++) await h.submit()
  await assert.rejects(h.submit(), { status: 429, code: 'FILA_CHEIA' })
  assert.equal((await h.sql`SELECT daily_tokens_reserved n FROM sac_operator_company_settings WHERE company_id=${h.A.id}`)[0].n, 5 * 512)
  await h.reset()
  await h.sql`UPDATE sac_operator_company_settings SET daily_token_budget=512 WHERE company_id=${h.A.id}`
  let accepted = 0; let refused = 0
  for (let i = 0; i < 30; i++) { try { await h.submit(); accepted++ } catch (e) { assert.equal((e as { status: number }).status, 429); refused++ } }
  assert.equal(accepted, 1); assert.equal(refused, 29)
})
test('T10: idempotência em cinco submits, uma fila e um privado', async () => {
  const key = randomUUID()
  const results = await Promise.all(Array.from({ length: 5 }, () => h.submit(h.A, 'Liste etapas', key)))
  assert.equal(new Set(results.map(r => r.job.id)).size, 1)
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_queue`)[0].n, 1)
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_job_privados`)[0].n, 1)
})
test('T11: lease perdido reentra, segunda tentativa completa, velho não escreve', async () => {
  await h.submit(); const old = (await h.take())!
  await h.sql`UPDATE sac_operator_queue SET lease_expira_em=now()-interval '1 second' WHERE job_id=${old.jobId}`
  await h.queue.varrer(h.A.id)
  assert.equal(await h.take(), null, 'backoff de três segundos')
  await h.sql`UPDATE sac_operator_queue SET disponivel_em=now()-interval '1 second' WHERE job_id=${old.jobId}`
  const fresh = (await h.take())!; assert.equal(fresh.epoch, old.epoch + 1); assert.notEqual(fresh.leaseToken, old.leaseToken)
  assert.equal(await h.queue.concluirCAS(h.lease(old)), null)
  assert.equal((await h.queue.completar(h.lease(fresh), h.body(fresh))).estado, 'aplicado')
})
test('T11: offline por seis minutos expira, libera reserva e apaga apenas privados da empresa', async () => {
  const a = await h.submit(); const b = await h.submit(h.B)
  await h.sql`UPDATE sac_operator_queue SET expira_em=now()-interval '1 minute' WHERE job_id=${a.job.id}`
  await h.queue.varrer(h.A.id)
  assert.equal((await h.sql`SELECT error_code FROM sac_operator_jobs WHERE id=${a.job.id}`)[0].error_code, 'EXECUTOR_TIMEOUT')
  assert.equal((await h.sql`SELECT daily_tokens_reserved n FROM sac_operator_company_settings WHERE company_id=${h.A.id}`)[0].n, 0)
  assert.deepEqual((await h.sql`SELECT job_id FROM sac_operator_job_privados`).map(r => r.job_id), [b.job.id])
  assert.equal((await h.take())!.jobId, b.job.id)
})
test('T11: aplicando abandonado não reexecuta nem toca job antes do reconciliador', async () => {
  await h.submit(); const c = (await h.take())!
  assert.ok(await h.queue.concluirCAS(h.lease(c)))
  await h.sql`UPDATE sac_operator_queue SET updated_at=now()-interval '3 minutes' WHERE job_id=${c.jobId}`
  await h.queue.varrer(h.A.id)
  assert.equal((await h.sql`SELECT status FROM sac_operator_jobs WHERE id=${c.jobId}`)[0].status, 'em_execucao')
  assert.equal((await h.sql`SELECT estado FROM sac_operator_queue WHERE job_id=${c.jobId}`)[0].estado, 'falhou')
  await h.sql`UPDATE sac_operator_jobs SET updated_at=now()-interval '11 minutes' WHERE id=${c.jobId}`
  await h.service.createOperatorService().expireStuck(h.A.id)
  assert.equal((await h.sql`SELECT error_code FROM sac_operator_jobs WHERE id=${c.jobId}`)[0].error_code, 'JOB_TIMEOUT')
  assert.equal(await h.take(), null)
})
test('falha repetível somente duas vezes; TOOL_USE_DETECTED não repete', async () => {
  await h.submit(); const c = (await h.take())!
  assert.equal((await h.queue.falhar(h.lease(c), { epoch: c.epoch, codigo: 'CLI_ERROR' })).estado, 'na_fila')
  await h.sql`UPDATE sac_operator_queue SET disponivel_em=now() WHERE job_id=${c.jobId}`
  const second = (await h.take())!
  assert.equal((await h.queue.falhar(h.lease(second), { epoch: second.epoch, codigo: 'MODEL_TIMEOUT' })).estado, 'falhou')
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_job_privados`)[0].n, 0)
  await h.submit(); const other = (await h.take())!
  assert.equal((await h.queue.falhar(h.lease(other), { epoch: other.epoch, codigo: 'TOOL_USE_DETECTED' })).estado, 'falhou')
})

test('prazos: claim exige mais de 60s; retry exige mais de 90s; lease de 45s', async () => {
  const first = await h.submit()
  await h.sql`UPDATE sac_operator_queue SET expira_em=now()+interval '59 seconds' WHERE job_id=${first.job.id}`
  assert.equal(await h.take(), null)
  await h.sql`UPDATE sac_operator_queue SET expira_em=now()+interval '89 seconds' WHERE job_id=${first.job.id}`
  const c = (await h.take())!; assert.ok(c)
  const leaseMs = new Date(c.leaseExpiraEm).getTime() - Date.now()
  assert.ok(leaseMs > 40000 && leaseMs <= 45000)
  assert.equal((await h.queue.falhar(h.lease(c), { epoch: c.epoch, codigo: 'MODEL_INVALID_OUTPUT' })).estado, 'falhou')
  assert.equal((await h.sql`SELECT daily_tokens_reserved n FROM sac_operator_company_settings WHERE company_id=${h.A.id}`)[0].n, 0)
})
test('revogação e mudança de escopo entre autenticação e CAS bloqueiam a escrita', async () => {
  await h.submit(); const c = (await h.take())!
  await h.sql`UPDATE sac_operator_executors SET revogado_em=now() WHERE id=${h.executor.id}`
  assert.equal(await h.queue.concluirCAS(h.lease(c)), null)
  await assert.rejects(h.queue.heartbeat(h.lease(c)), { code: 'LEASE_CONFLICT' })
  await h.sql`UPDATE sac_operator_executors SET revogado_em=NULL, empresas_permitidas=${h.sql.json([h.B.id])} WHERE id=${h.executor.id}`
  assert.equal(await h.queue.concluirCAS(h.lease(c)), null)
  await assert.rejects(h.queue.falhar(h.lease(c), { epoch: c.epoch, codigo: 'CLI_ERROR' }), { code: 'LEASE_CONFLICT' })
})

test('enfileiramento concorrente limita exatamente cinco, sem reserva vazada', async () => {
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => h.submit()))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 5)
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_queue`)[0].n, 5)
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_job_privados`)[0].n, 5)
  assert.equal((await h.sql`SELECT daily_tokens_reserved n FROM sac_operator_company_settings WHERE company_id=${h.A.id}`)[0].n, 5 * 512)
})


test('heartbeat mantém último contato durante o CLI sem precisar de outro claim', async () => {
  await h.submit(); const c = (await h.take())!
  await h.sql`UPDATE sac_operator_executors SET ultimo_contato_em=now()-interval '41 seconds' WHERE id=${h.executor.id}`
  assert.deepEqual(await h.queue.heartbeat(h.lease(c)), { continuar: true })
  assert.equal((await h.sql`SELECT ultimo_contato_em > now()-interval '2 seconds' AS fresh FROM sac_operator_executors WHERE id=${h.executor.id}`)[0].fresh, true)
})
