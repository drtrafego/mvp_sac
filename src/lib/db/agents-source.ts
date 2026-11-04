/**
 * A única fonte operacional dos agentes do SAC.
 *
 * O hostname vem da configuração já usada por
 * /opt/gastaomatos/hermes/central-db/.neon, que foi a fonte que recebeu as
 * mensagens do Gramado depois do cutover de 17/10/2026. A credencial inteira
 * continua exclusivamente no ambiente; este arquivo registra apenas a
 * identidade não secreta necessária para impedir um fallback silencioso.
 */
export const AGENTS_DATABASE_ENV = 'AGENTS_DATABASE_URL' as const
export const CENTRAL_AGENTS_DB_HOST = 'ep-hidden-dust-acu81nrx-pooler.sa-east-1.aws.neon.tech'

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
      database: null,
      ignoredLegacyEnvs,
      reason: `${AGENTS_DATABASE_ENV} não contém uma URL PostgreSQL válida`,
      url: null,
    }
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return {
      status: 'invalid_canonical_url',
      source: null,
      env: AGENTS_DATABASE_ENV,
      host: parsed.hostname || null,
      database: safeDatabaseName(parsed),
      ignoredLegacyEnvs,
      reason: `${AGENTS_DATABASE_ENV} deve usar o protocolo PostgreSQL`,
      url: null,
    }
  }

  if (parsed.hostname !== CENTRAL_AGENTS_DB_HOST) {
    return {
      status: 'wrong_central_host',
      source: null,
      env: AGENTS_DATABASE_ENV,
      host: parsed.hostname || null,
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
    host: parsed.hostname,
    database: safeDatabaseName(parsed),
    ignoredLegacyEnvs,
    reason: null,
    url: rawUrl,
  }
}
