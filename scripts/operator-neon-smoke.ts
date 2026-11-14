// Smoke manual para um branch Neon descartável. Nunca execute em produção.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import postgres from 'postgres'

function endpoint(url: string) {
  const parsed = new URL(url)
  // O pooler e a URL direta apontam ao mesmo endpoint Neon.
  const hostname = parsed.hostname.toLowerCase().replace(/-pooler(?=\.|$)/u, '')
  return `${hostname}${parsed.pathname.replace(/\/$/u, '')}`
}

function databaseName(url: string) {
  const value = new URL(url).pathname.replace(/^\/+|\/+$/gu, '')
  if (!value) throw new Error('A URL do smoke precisa informar o nome do banco ou branch.')
  return value
}

function allowedDatabases() {
  const raw = process.env.OPERATOR_SMOKE_ALLOWED_DATABASE
  if (!raw) throw new Error('Defina OPERATOR_SMOKE_ALLOWED_DATABASE com o nome explícito do banco ou branch descartável.')
  return new Set(raw.split(',').map(value => value.trim()).filter(Boolean))
}

function postgresUrlsFromEnvironment() {
  return Object.entries(process.env)
    .filter(([name, value]) => name !== 'OPERATOR_SMOKE_DATABASE_URL' && !name.startsWith('OPERATOR_SMOKE_') && /^postgres(?:ql)?:\/\//iu.test(value ?? ''))
    .map(([, value]) => value as string)
}

async function main() {
  const url = process.env.OPERATOR_SMOKE_DATABASE_URL
  if (!url) throw new Error('Defina OPERATOR_SMOKE_DATABASE_URL para um branch Neon descartável.')
  if (process.env.OPERATOR_SMOKE_CONFIRM !== 'sim') throw new Error('Defina OPERATOR_SMOKE_CONFIRM=sim depois de conferir o branch descartável.')
  if (!allowedDatabases().has(databaseName(url))) throw new Error('O banco ou branch do smoke não está na lista OPERATOR_SMOKE_ALLOWED_DATABASE.')
  if (postgresUrlsFromEnvironment().some(value => endpoint(value) === endpoint(url))) throw new Error('O endpoint informado coincide com uma URL PostgreSQL conhecida no ambiente e foi recusado.')

  const sql = postgres(url, { max: 12, prepare: false })
  const companyId = 2_000_000_000 + Math.floor(Math.random() * 100_000_000)
  const migration = await readFile(resolve(process.cwd(), 'drizzle/0044_sac_operator.sql'), 'utf8')
  try {
    const [{ exists }] = await sql<{ exists: boolean }[]>`select to_regclass('public.recovery_leads') is not null as exists`
    if (exists) {
      const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from recovery_leads`
      if (count > 0) throw new Error('O alvo do smoke já contém recovery_leads e foi recusado.')
    }
    await sql.unsafe(migration)
    await sql`insert into sac_operator_company_settings (company_id, enabled, max_jobs_per_day, daily_token_budget)
      values (${companyId}, true, 3, 10000)`
    const reserve = async (key: string) => sql<{ id: string }[]>`
      with new_job as (
        insert into sac_operator_jobs (id, company_id, requested_by_user_id, role, request_text, idempotency_key, status, reserved_tokens)
        values (${randomUUID()}::uuid, ${companyId}, 'smoke', 'admin', 'listar etapas', ${key}, 'pendente', 512)
        on conflict (company_id, idempotency_key) do nothing returning id
      ), quota as (
        update sac_operator_company_settings settings
        set daily_usage_date = (now() at time zone 'UTC')::date,
            daily_jobs_reserved = case when settings.daily_usage_date is distinct from (now() at time zone 'UTC')::date then 1 else settings.daily_jobs_reserved + 1 end,
            daily_tokens_reserved = case when settings.daily_usage_date is distinct from (now() at time zone 'UTC')::date then 512 else settings.daily_tokens_reserved + 512 end
        from new_job where settings.company_id = ${companyId}
          and (settings.daily_usage_date is distinct from (now() at time zone 'UTC')::date or settings.daily_jobs_reserved < settings.max_jobs_per_day)
          and (settings.daily_usage_date is distinct from (now() at time zone 'UTC')::date or settings.daily_tokens_reserved + 512 <= settings.daily_token_budget)
        returning settings.company_id
      ) select new_job.id from new_job, quota`

    const first = await reserve('unica')
    const simultaneous = await Promise.all(Array.from({ length: 10 }, () => reserve('mesma-chave')))
    const [counter] = await sql`select daily_jobs_reserved, daily_tokens_reserved from sac_operator_company_settings where company_id = ${companyId}`
    const [{ count: jobs }] = await sql<{ count: number }[]>`select count(*)::int as count from sac_operator_jobs where company_id = ${companyId}`
    if (first.length !== 1 || simultaneous.filter(result => result.length === 1).length !== 1 || jobs !== 2 || counter.daily_jobs_reserved !== 2 || counter.daily_tokens_reserved !== 1024) throw new Error('Smoke falhou: a CTE não preservou idempotência ou reserva.')
    console.log('Smoke passou: migration idempotente, reserva e 10 chamadas simultâneas verificadas.')
  } finally {
    // Limpa só se as tabelas existirem (numa recusa antes do DDL elas não existem) e SEMPRE
    // fecha a conexão, para a mensagem de recusa aparecer e o processo terminar.
    try {
      const [{ existem }] = await sql<{ existem: boolean }[]>`select (to_regclass('sac_operator_jobs') is not null and to_regclass('sac_operator_company_settings') is not null) as existem`
      if (existem) {
        await sql`delete from sac_operator_jobs where company_id = ${companyId}`
        await sql`delete from sac_operator_company_settings where company_id = ${companyId}`
      }
    } catch { /* limpeza best-effort: não mascara o erro original */ }
    finally { await sql.end({ timeout: 5 }) }
  }
}

void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
