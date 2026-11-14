// Uso: node --import tsx --test scripts/instagram-story-apply-migration.test.ts
// Exercita o mesmo contrato .query do neon contra um PostgreSQL descartável PGlite.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { createSacTestDatabase } from './sac-test-pglite'
import { applyMigration, splitPostgresStatements } from './instagram-story-apply-migration'
import { companies } from '../src/lib/db/schema'

test('separa strings e blocos $$ sem cortar no ponto e vírgula interno', () => {
  assert.deepEqual(splitPostgresStatements("SELECT ';'; DO $$ BEGIN PERFORM ';'; END $$; SELECT 2;"), ["SELECT ';'", "DO $$ BEGIN PERFORM ';'; END $$", 'SELECT 2'])
})

test('aplica a migração duas vezes, uma instrução .query por vez, sem tocar tabela existente', async () => {
  const fixture = await createSacTestDatabase([companies])
  try {
    await fixture.pg.query("insert into companies (name, slug) values ('piloto', 'isabela-fanini')")
    const migration = await readFile(resolve(process.cwd(), 'drizzle/0045_instagram_story_trigger.sql'), 'utf8')
    const calls: string[] = []
    const neonLike = {
      query: async (statement: string) => {
        calls.push(statement)
        if (statement === 'SELECT current_database() AS name') return [{ name: 'story_test' }]
        await fixture.pg.exec(statement)
        return []
      },
    }
    await applyMigration(neonLike, migration, 'story_test')
    await applyMigration(neonLike, migration, 'story_test')
    const tables = await fixture.pg.query("select table_name from information_schema.tables where table_name like 'instagram_story_%' order by table_name")
    assert.deepEqual(tables.rows.map((row: { table_name: string }) => row.table_name), ['instagram_story_automations', 'instagram_story_deliveries'])
    assert.equal(calls.length, (splitPostgresStatements(migration).length * 2) + 2, 'cada statement foi enviado individualmente por .query')
    const company = await fixture.pg.query("select slug from companies where slug='isabela-fanini'")
    assert.equal(company.rows.length, 1)
  } finally { await fixture.close() }
})
