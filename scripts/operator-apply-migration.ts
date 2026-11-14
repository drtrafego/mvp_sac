// Aplicador explícito da migration aditiva do Operador SAC.
// Padrão: apenas mostra o SQL. Nunca usa ensureSchema e nunca é chamado pelo app.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import postgres from 'postgres'

const APPLY = process.argv.includes('--apply')
const DRY_RUN = process.argv.length === 2 || process.argv.includes('--dry-run')

function databaseName(value: string): string | null {
  try { return decodeURIComponent(new URL(value).pathname.replace(/^\//, '')) || null } catch { return null }
}
async function main() {
  const file = resolve(process.cwd(), 'drizzle/0044_sac_operator.sql')
  const migration = await readFile(file, 'utf8')
  if (!APPLY || DRY_RUN) { console.log(migration); console.log('\nModo dry-run: nenhuma alteração foi aplicada. Use --apply com as confirmações explícitas.'); return }
  if (process.env.OPERATOR_MIGRATION_CONFIRM !== 'sim') throw new Error('Defina OPERATOR_MIGRATION_CONFIRM=sim para aplicar a migration.')
  const url = process.env.OPERATOR_MIGRATION_DATABASE_URL
  const expected = process.env.OPERATOR_MIGRATION_EXPECTED_DATABASE
  if (!url || !expected) throw new Error('Defina OPERATOR_MIGRATION_DATABASE_URL e OPERATOR_MIGRATION_EXPECTED_DATABASE.')
  if (databaseName(url) !== expected) throw new Error('O banco da URL não corresponde a OPERATOR_MIGRATION_EXPECTED_DATABASE.')
  const host = new URL(url).hostname
  if (!['localhost', '127.0.0.1', '::1'].includes(host) && process.env.OPERATOR_MIGRATION_ALLOW_REMOTE !== 'sim') throw new Error('Banco remoto bloqueado. Defina OPERATOR_MIGRATION_ALLOW_REMOTE=sim após conferir o alvo.')
  const sql = postgres(url, { max: 1, prepare: false })
  try { await sql.unsafe(migration); console.log(`Migration 0044 aplicada em ${expected}.`) } finally { await sql.end({ timeout: 5 }) }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
