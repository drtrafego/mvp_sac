// Snapshot somente leitura para a empresa 2. Não é executado automaticamente.
import postgres from 'postgres'

const queries = [
  `SELECT scope, active, paused_at FROM company_pause_switches WHERE company_id = 2 AND scope = 'all'`,
  `SELECT count(*)::int AS leads_pausados FROM recovery_leads WHERE company_id = 2 AND bot_paused = true`,
  `SELECT count(*)::int AS regras_instagram_ativas FROM instagram_comment_automations WHERE company_id = 2 AND is_active = true`,
]

async function main() {
  if (!process.argv.includes('--run')) { console.log(queries.join(';\n') + ';\n\nModo seguro: nenhuma consulta executada. Use --run e confirmação explícita.'); return }
  if (process.env.OPERATOR_SNAPSHOT_CONFIRM !== 'sim') throw new Error('Defina OPERATOR_SNAPSHOT_CONFIRM=sim para executar o snapshot de leitura.')
  const url = process.env.OPERATOR_SNAPSHOT_DATABASE_URL
  if (!url) throw new Error('Defina OPERATOR_SNAPSHOT_DATABASE_URL.')
  const client = postgres(url, { max: 1, prepare: false })
  try { console.log(JSON.stringify(await Promise.all(queries.map(query => client.unsafe(query))), null, 2)) } finally { await client.end({ timeout: 5 }) }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
