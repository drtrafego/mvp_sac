import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENTS_DATABASE_ENV,
  CENTRAL_AGENTS_DB_HOST,
  resolveAgentsDbSource,
} from '../src/lib/db/agents-source'

const centralUrl = `postgresql://central_user:secret-value@${CENTRAL_AGENTS_DB_HOST}/neondb?sslmode=require&channel_binding=require`

test('usa somente AGENTS_DATABASE_URL quando aponta para o Neon central', () => {
  const resolved = resolveAgentsDbSource({
    AGENTS_DATABASE_URL: centralUrl,
    CRM_DATABASE_URL: 'postgresql://legacy:secret@old.example.invalid/old',
    SUPABASE_DATABASE_URL: 'postgresql://legacy:secret@aws-0-old.pooler.supabase.com/postgres',
  })

  assert.equal(resolved.status, 'configured')
  assert.equal(resolved.source, 'hermes-central-neon')
  assert.equal(resolved.env, AGENTS_DATABASE_ENV)
  assert.equal(resolved.host, CENTRAL_AGENTS_DB_HOST)
  assert.deepEqual(resolved.ignoredLegacyEnvs, ['CRM_DATABASE_URL', 'SUPABASE_DATABASE_URL'])
  const safeDiagnostic = { ...resolved, url: null }
  assert.equal(JSON.stringify(safeDiagnostic).includes('secret-value'), false)
  assert.equal(JSON.stringify(safeDiagnostic).includes('old.example'), false)
})

test('recusa fontes antigas quando a fonte canônica está ausente', () => {
  const resolved = resolveAgentsDbSource({
    CRM_DATABASE_URL: 'postgresql://legacy:secret@old.example.invalid/old',
    SUPABASE_DATABASE_URL: 'postgresql://legacy:secret@aws-0-old.pooler.supabase.com/postgres',
  })

  assert.equal(resolved.status, 'missing_canonical_env')
  assert.equal(resolved.url, null)
  assert.deepEqual(resolved.ignoredLegacyEnvs, ['CRM_DATABASE_URL', 'SUPABASE_DATABASE_URL'])
})

test('recusa um AGENTS_DATABASE_URL que aponta para outro banco', () => {
  const resolved = resolveAgentsDbSource({
    AGENTS_DATABASE_URL: 'postgresql://legacy:secret@aws-0-old.pooler.supabase.com/postgres',
  })

  assert.equal(resolved.status, 'wrong_central_host')
  assert.equal(resolved.url, null)
  assert.equal(resolved.host, 'aws-0-old.pooler.supabase.com')
})

test('recusa URL canônica inválida sem tentar fallback', () => {
  const resolved = resolveAgentsDbSource({ AGENTS_DATABASE_URL: 'not-a-postgres-url' })

  assert.equal(resolved.status, 'invalid_canonical_url')
  assert.equal(resolved.url, null)
})
