import postgres from 'postgres'
import { resolveAgentsDbSource, type AgentsDbSourceDiagnostic } from './agents-source'

let _sqlInstance: ReturnType<typeof postgres> | null = null
let _lastUrl: string | null = null

export function getAgentsDbSourceDiagnostic(): AgentsDbSourceDiagnostic {
  const { url: _url, ...diagnostic } = resolveAgentsDbSource()
  return diagnostic
}

function logSourceDiagnostic(diagnostic: AgentsDbSourceDiagnostic): void {
  const legacy = diagnostic.ignoredLegacyEnvs.length > 0
    ? `; legadas ignoradas=${diagnostic.ignoredLegacyEnvs.join(',')}`
    : ''
  if (diagnostic.status === 'configured') {
    console.log(
      `[Agents DB] Fonte=${diagnostic.source} env=${diagnostic.env} host=${diagnostic.host} ` +
      `port=${diagnostic.port || '(default)'} database=${diagnostic.database || '(default)'}${legacy}`,
    )
    return
  }
  console.error(
    `[Agents DB] Fonte recusada status=${diagnostic.status} env=${diagnostic.env || '(nenhuma)'} ` +
    `host=${diagnostic.host || '(nenhum)'} port=${diagnostic.port || '(nenhuma)'}${legacy}; motivo=${diagnostic.reason}`,
  )
}

export async function getAgentsDbUrl(): Promise<string | null> {
  const resolved = resolveAgentsDbSource()
  const { url, ...diagnostic } = resolved
  logSourceDiagnostic(diagnostic)
  return diagnostic.status === 'configured' ? url : null
}

/**
 * Retorna o cliente nativo postgres configurado para o banco central dos agentes.
 * Utiliza SSL requerido e nunca aceita uma fonte legada ou um banco arbitrário.
 */
export async function getAgentsDb() {
  const url = await getAgentsDbUrl()
  if (!url) return null

  if (_sqlInstance && _lastUrl === url) {
    return _sqlInstance
  }

  _lastUrl = url
  _sqlInstance = postgres(url, {
    ssl: 'require',
    max: 5,
    idle_timeout: 20,
    connect_timeout: 30,
    prepare: false,
  })

  return _sqlInstance
}

/**
 * Executa uma consulta direta no banco central de agentes.
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
    const message = error instanceof Error ? error.message : String(error)
    console.error('[Agents DB Error]:', message.replace(/postgres(?:ql)?:\/\/[^\s)]+/gi, 'postgres://[redacted]'))
    return null
  }
}
