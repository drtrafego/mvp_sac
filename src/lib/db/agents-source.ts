/**
 * A única fonte operacional dos agentes do SAC.
 *
 * A identidade não secreta vem do Neon central do Hermes, em
 * /opt/gastaomatos/hermes/central-db/.neon.
 * A credencial inteira continua exclusivamente no ambiente; este arquivo
 * registra apenas host, porta e database para impedir fallback silencioso
 * para o banco operacional do SAC ou para outro banco.
 */
export const AGENTS_DATABASE_ENV = 'AGENTS_DATABASE_URL' as const
export const CENTRAL_AGENTS_DB_HOST = 'ep-hidden-dust-acu81nrx-pooler.sa-east-1.aws.neon.tech'
export const CENTRAL_AGENTS_DB_PORT = '5432'
export const CENTRAL_AGENTS_DB_NAME = 'neondb'

const LEGACY_DATABASE_ENVS = ['CRM_DATABASE_URL', 'SUPABASE_DATABASE_URL'] as const

export type AgentsDbSourceStatus =
  | 'configured'
  | 'missing_canonical_env'
  | 'invalid_canonical_url'
  | 'wrong_central_host'

export interface AgentsDbSourceDiagnostic {
  status: AgentsDbSourceStatus
  source: 'hermes-central-neon' | null
  env: typeof AGENTS_DATABASE_ENV | null
  host: string | null
  port: string | null
  database: string | null
  ignoredLegacyEnvs: string[]
  reason: string | null
}

export interface ResolvedAgentsDbSource extends AgentsDbSourceDiagnostic {
  url: string | null
}

function safeDatabaseName(url: URL): string | null {
  const database = url.pathname.replace(/^\/+/, '')
  return database || null
}

export function resolveAgentsDbSource(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedAgentsDbSource {
  const ignoredLegacyEnvs = LEGACY_DATABASE_ENVS.filter((name) => Boolean(env[name]))
  const rawUrl = env[AGENTS_DATABASE_ENV]?.trim()

  if (!rawUrl) {
    return {
      status: 'missing_canonical_env',
      source: null,
      env: null,
      host: null,
      port: null,
      database: null,
      ignoredLegacyEnvs,
      reason: `${AGENTS_DATABASE_ENV} é obrigatória; fontes legadas não são usadas`,
      url: null,
    }
  }

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return {
      status: 'invalid_canonical_url',
      source: null,
      env: AGENTS_DATABASE_ENV,
      host: null,
      port: null,
      database: null,
      ignoredLegacyEnvs,
      reason: `${AGENTS_DATABASE_ENV} não contém uma URL PostgreSQL válida`,
      url: null,
    }
  }

  const normalizedHostname = parsed.hostname.toLowerCase()

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return {
      status: 'invalid_canonical_url',
      source: null,
      env: AGENTS_DATABASE_ENV,
      host: normalizedHostname || null,
      port: parsed.port || null,
      database: safeDatabaseName(parsed),
      ignoredLegacyEnvs,
      reason: `${AGENTS_DATABASE_ENV} deve usar o protocolo PostgreSQL`,
      url: null,
    }
  }

  const effectivePort = parsed.port || CENTRAL_AGENTS_DB_PORT
  if (normalizedHostname !== CENTRAL_AGENTS_DB_HOST || effectivePort !== CENTRAL_AGENTS_DB_PORT || safeDatabaseName(parsed) !== CENTRAL_AGENTS_DB_NAME) {
    return {
      status: 'wrong_central_host',
      source: null,
      env: AGENTS_DATABASE_ENV,
      host: normalizedHostname || null,
      port: parsed.port || null,
      database: safeDatabaseName(parsed),
      ignoredLegacyEnvs,
      reason: `${AGENTS_DATABASE_ENV} não aponta para a fonte central de agentes`,
      url: null,
    }
  }

  return {
    status: 'configured',
    source: 'hermes-central-neon',
    env: AGENTS_DATABASE_ENV,
    host: normalizedHostname,
    port: effectivePort,
    database: safeDatabaseName(parsed),
    ignoredLegacyEnvs,
    reason: null,
    url: rawUrl,
  }
}
