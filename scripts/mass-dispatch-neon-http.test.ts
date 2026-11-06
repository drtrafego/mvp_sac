import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

let executeCalls = 0

// Espelha o contrato de drizzle-orm/neon-http relevante para este bug: há
// execute(), mas não há transaction(). Antes do conserto, as duas filas
// lançavam "No transactions support in neon-http driver" aqui.
const neonHttpDb = {
  execute: async () => {
    executeCalls++
    if (executeCalls === 1) {
      return [{
        batch_count: 1,
        eligible_job_count: 1,
        non_template_count: 0,
        preview_matches: true,
        reserved_count: 0,
        jobs_created: 1,
      }]
    }
    return [{
      batch_count: 1,
      eligible_job_count: 1,
      preview_matches: true,
      reserved_count: 0,
      jobs_created: 1,
    }]
  },
}

mock.module('@/lib/db', { namedExports: { db: neonHttpDb } })

test('as duas confirmações de lote funcionam no driver neon-http sem transaction', async () => {
  const { queueDirectTemplateMassDispatchBatch, queueMassDispatchBatch } = await import('../src/lib/mass-dispatch')

  const sequenceBatch = await queueMassDispatchBatch(1, 7, 'meta-phone-test', [])
  const directTemplateBatch = await queueDirectTemplateMassDispatchBatch(2, 7, 'meta-phone-test', [])

  assert.deepEqual(sequenceBatch, { status: 'queued', jobsCreated: 1 })
  assert.deepEqual(directTemplateBatch, { status: 'queued', jobsCreated: 1 })
  assert.equal(executeCalls, 2)
  assert.equal('transaction' in neonHttpDb, false)
})
