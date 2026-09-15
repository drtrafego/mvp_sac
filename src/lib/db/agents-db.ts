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

export async function getAgentsDbUrl(): Promise<string | null> {
  if (process.env.SUPABASE_DATABASE_URL) return process.env.SUPABASE_DATABASE_URL
  if (process.env.AGENTS_DATABASE_URL) return process.env.AGENTS_DATABASE_URL

  try {
    const rows = await db
      .select({ url: settings.supabaseDatabaseUrl })
      .from(settings)
      .where(isNotNull(settings.supabaseDatabaseUrl))
      .limit(1)

    if (rows[0]?.url) return rows[0].url
  } catch (err) {
    // Silently continue to fallback
  }

  return process.env.DATABASE_URL || null
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
