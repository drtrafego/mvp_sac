import { neon } from '@neondatabase/serverless'

/**
 * Retorna a conexão com o banco de dados dos Agentes de IA (Supabase).
 * Se SUPABASE_DATABASE_URL ou AGENTS_DATABASE_URL estiver configurada, conecta no Supabase.
 * Caso contrário, utiliza a DATABASE_URL principal (Neon) como fallback.
 */
export function getAgentsDb() {
  const agentsUrl =
    process.env.SUPABASE_DATABASE_URL ||
    process.env.AGENTS_DATABASE_URL ||
    process.env.DATABASE_URL

  if (!agentsUrl) {
    return null
  }

  return neon(agentsUrl)
}

/**
 * Executa uma consulta direta no banco de dados de agentes (Supabase)
 */
export async function queryAgentsDb<T = Record<string, unknown>>(
  query: string,
  params: unknown[] = []
): Promise<T[] | null> {
  const sql = getAgentsDb()
  if (!sql) return null

  try {
    const rows = await sql(query, params)
    return rows as unknown as T[]
  } catch (error) {
    console.error('[Agents DB Error]:', error)
    return null
  }
}
