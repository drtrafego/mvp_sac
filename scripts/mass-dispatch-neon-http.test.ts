import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('as duas confirmações usam transação postgres-js e separam a trava do claim', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/lib/mass-dispatch.ts'), 'utf8')
  const transactionSource = readFileSync(resolve(process.cwd(), 'src/lib/mass-dispatch-transaction.ts'), 'utf8')

  assert.match(transactionSource, /import postgres from 'postgres'/)
  assert.match(transactionSource, /postgresDrizzle\(client\)/)
  assert.match(transactionSource, /transactionalDb\.transaction/)
  assert.match(source, /withConfirmationTransaction/)
  assert.match(source, /await tx\.execute\(sql`SELECT pg_advisory_xact_lock/)
  assert.doesNotMatch(source, /WITH confirmation_lock AS/)
  assert.match(source, /claimed_count/)
})
