import postgres from 'postgres'
import { db } from './index'
import { settings } from './schema'
import { isNotNull } from 'drizzle-orm'

function toTransactionPooler(url: string): string {
  if (url.includes('pooler.supabase.com') && url.includes(':5432')) {
    return url.replace(':5432', ':6543')
  }
  return url
}

let _sqlInstance: ReturnType<typeof postgres> | null = null
let _lastUrl: string | null = null

function maskUrl(url: string): string {
  return url.replace(/:[^:@]+@/, ':****@')
}

// Investigado em 19/09/2026: a rota /api/cron/sync-agents (nova) e a rota
// /api/admin/sync-agents (antiga) chamam a MESMA syncAgentsAndCompanies(),
// que chama esta MESMA função, sem nenhum parâmetro. Não existe divergência
// de código entre as duas. Os logs de produção mostram as DUAS rotas caindo
// no mesmo erro ("relation public.leads does not exist" / "column
// created_at does not exist") no mesmo dia, então o problema nunca foi uma
// rota resolvendo certo e a outra errado: é a env var de produção
// (AGENTS_DATABASE_URL, a única configurada na Vercel) apontando para um
// banco sem o schema esperado, e/ou a query em `settings.supabaseDatabaseUrl`
// não achando nada e caindo no fallback abaixo.
// Esta função agora LOGA (mascarado, nunca a credencial completa) qual fonte
// foi usada em cada chamada, pra próxima investigação não precisar adivinhar.
export async function getAgentsDbUrl(): Promise<string | null> {
  const envCandidates: [string, string | undefined][] = [
    ['CRM_DATABASE_URL', process.env.CRM_DATABASE_URL],
    ['SUPABASE_DATABASE_URL', process.env.SUPABASE_DATABASE_URL],
    ['AGENTS_DATABASE_URL', process.env.AGENTS_DATABASE_URL],
  ]

  for (const [name, value] of envCandidates) {
    if (value) {
      console.log(`[Agents DB] URL resolvida via env ${name}: ${maskUrl(value)}`)
      return value
    }
  }

  try {
    const rows = await db
      .select({ url: settings.supabaseDatabaseUrl })
      .from(settings)
      .where(isNotNull(settings.supabaseDatabaseUrl))
      .limit(1)

    if (rows[0]?.url) {
      console.log(`[Agents DB] URL resolvida via settings.supabaseDatabaseUrl: ${maskUrl(rows[0].url)}`)
      return rows[0].url
    }
  } catch (err) {
    console.error('[Agents DB] Falha ao consultar settings.supabaseDatabaseUrl, seguindo sem banco configurado:', err)
  }

  // Removido o fallback hardcoded para um banco Neon de terceiros
  // (ep-red-water-ahtndd0s...neon.tech). Ele já tinha sido apontado como
  // risco numa investigação anterior: silenciosamente conectava num banco
  // com schema diferente do esperado (sem public.leads, sem created_at em
  // ctwa_referrals) e gerava exatamente os erros vistos em produção em
  // 19/09/2026, tanto na rota antiga quanto na nova. Falhar fechado (null)
  // é melhor que sincronizar dados errados sem avisar ninguém.
  console.error('[Agents DB] Nenhuma fonte de configuração encontrada (env CRM_DATABASE_URL/SUPABASE_DATABASE_URL/AGENTS_DATABASE_URL nem settings.supabaseDatabaseUrl). Configure uma delas.')
  return null
}

/**
 * Retorna o cliente nativo postgres configurado para o banco dos Agentes IA (Supabase).
 * Utiliza modo de pooler seguro (prepare: false) e SSL requerido.
 */
export async function getAgentsDb() {
  const url = await getAgentsDbUrl()
  if (!url) return null

  if (_sqlInstance && _lastUrl === url) {
    return _sqlInstance
  }

  _lastUrl = url
  _sqlInstance = postgres(toTransactionPooler(url), {
    ssl: 'require',
    max: 5,
    idle_timeout: 20,
    connect_timeout: 30,
    prepare: false, // Obrigatório para Supabase em transaction mode (porta 6543)
  })

  return _sqlInstance
}

/**
 * Executa uma consulta direta no banco de dados de agentes (Supabase)
 */
export async function queryAgentsDb<T = Record<string, unknown>>(
  query: string,
  params: any[] = []
): Promise<T[] | null> {
  const sql = await getAgentsDb()
  if (!sql) return null

  try {
    const rows = await sql.unsafe(query, params)
    return rows as unknown as T[]
  } catch (error) {
    console.error('[Agents DB Error]:', error)
    return null
  }
}
