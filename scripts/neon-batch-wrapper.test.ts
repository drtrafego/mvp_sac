import assert from 'node:assert/strict'
import test from 'node:test'
import { neon } from '@neondatabase/serverless'
import { pgTable, serial, text } from 'drizzle-orm/pg-core'
import { createNeonDbPair } from '../src/lib/db/neon-client'

const t = pgTable('t', { id: serial('id').primaryKey(), v: text('v') })

test('batch do cliente sem embrulho entrega queries do neon (com queryData) ao transaction', async () => {
  const raw: any = neon('postgres://u:p@127.0.0.1:1/db')
  let received: unknown[] = []
  raw.transaction = async (queries: unknown[]) => {
    received = queries
    return queries.map(() => ({ rows: [], fields: [], rowCount: 0, rowAsArray: false, command: 'INSERT' }))
  }
  let ensured = 0
  const { wrapped, raw: rawDb } = createNeonDbPair(raw, async () => { ensured += 1 })

  // Statements montados no db EMBRULHADO (como o código de produção faz)...
  const statements = [
    wrapped.insert(t).values({ v: 'a' }).onConflictDoNothing().returning({ id: t.id }),
    wrapped.insert(t).values({ v: 'b' }).onConflictDoNothing(),
  ] as unknown as Parameters<typeof rawDb.batch>[0]
  // ...executados pelo drizzle ligado ao cliente SEM embrulho.
  await rawDb.batch(statements)

  assert.equal(received.length, 2)
  for (const q of received) assert.ok(q && typeof q === 'object' && 'queryData' in (q as object), 'cada item precisa ser query do neon')
})

test('db.batch de produção usa o cliente cru: src/lib/db/index.ts expõe batch via _rawDb', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/lib/db/index.ts', import.meta.url), 'utf8')
  assert.match(src, /prop === 'batch'/)
  assert.match(src, /_rawDb!\.batch\(queries\)/)
})
