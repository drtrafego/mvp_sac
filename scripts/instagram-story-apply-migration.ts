import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { neon } from '@neondatabase/serverless'

const migrationPath = resolve(process.cwd(), 'drizzle/0045_instagram_story_trigger.sql')
const args = new Set(process.argv.slice(2))
const expectedDatabase = process.argv.find(arg => arg.startsWith('--database='))?.slice('--database='.length)

type NeonQueryClient = { query: (statement: string) => Promise<Array<{ name?: string }>> }

/** Splits only top-level statements, preserving quoted strings and dollar bodies. */
export function splitPostgresStatements(source: string): string[] {
  const statements: string[] = []; let start = 0; let quote: "'" | '"' | null = null; let dollarTag: string | null = null; let lineComment = false; let blockComment = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]; const next = source[index + 1]
    if (lineComment) { if (char === '\n') lineComment = false; continue }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; index += 1 }; continue }
    if (quote) { if (char === quote && source[index - 1] !== '\\') quote = null; continue }
    if (dollarTag) { if (source.startsWith(dollarTag, index)) { index += dollarTag.length - 1; dollarTag = null }; continue }
    if (char === '-' && next === '-') { lineComment = true; index += 1; continue }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char === '$') { const match = source.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/); if (match) { dollarTag = match[0]; index += dollarTag.length - 1; continue } }
    if (char === ';') { const statement = source.slice(start, index).trim(); if (statement) statements.push(statement); start = index + 1 }
  }
  const last = source.slice(start).trim(); if (last) statements.push(last)
  return statements
}

export async function applyMigration(client: NeonQueryClient, migration: string, database: string): Promise<void> {
  const databaseRows = await client.query('SELECT current_database() AS name')
  if (databaseRows[0]?.name !== database) throw new Error(`Aplicação recusada: banco atual "${databaseRows[0]?.name ?? 'desconhecido'}" não é "${database}".`)
  for (const statement of splitPostgresStatements(migration)) await client.query(statement)
}

export async function main() {
  const migration = await readFile(migrationPath, 'utf8')
  if (!args.has('--apply')) {
    console.log('Dry-run: a migração não foi aplicada. Use --apply --confirmar --database=NOME_DO_BANCO para aplicar.')
    console.log(migration)
    return
  }
  if (!args.has('--confirmar') || !expectedDatabase) throw new Error('Aplicação recusada: informe --confirmar e --database=NOME_DO_BANCO.')
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('Aplicação recusada: DATABASE_URL não configurada.')
  const client = neon(databaseUrl) as unknown as NeonQueryClient
  await applyMigration(client, migration, expectedDatabase)
  console.log(`Migração 0045 aplicada em ${expectedDatabase}.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
}
