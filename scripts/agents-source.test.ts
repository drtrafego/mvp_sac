import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENTS_DATABASE_ENV,
  CENTRAL_AGENTS_DB_HOST,
  CENTRAL_AGENTS_DB_PORT,
  CENTRAL_AGENTS_DB_NAME,
  resolveAgentsDbSource,
} from '../src/lib/db/agents-source'

const centralUrl = `postgresql://central_user:secret-value@${CENTRAL_AGENTS_DB_HOST}:${CENTRAL_AGENTS_DB_PORT}/${CENTRAL_AGENTS_DB_NAME}?sslmode=require`

test('usa somente AGENTS_DATABASE_URL quando aponta para o Supabase central comprovado', () => {
  const resolved = resolveAgentsDbSource({
    AGENTS_DATABASE_URL: centralUrl,
    CRM_DATABASE_URL: 'postgresql://legacy:secret@old.example.invalid/old',
    SUPABASE_DATABASE_URL: 'postgresql://legacy:secret@aws-0-old.pooler.supabase.com/postgres',
  })

  assert.equal(resolved.status, 'configured')
  assert.equal(resolved.source, 'hermes-central-supabase')
  assert.equal(resolved.env, AGENTS_DATABASE_ENV)
  assert.equal(resolved.host, CENTRAL_AGENTS_DB_HOST)
  assert.equal(resolved.port, CENTRAL_AGENTS_DB_PORT)
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
    AGENTS_DATABASE_URL: 'postgresql://legacy:secret@ep-hidden-dust-acu81nrx-pooler.sa-east-1.aws.neon.tech/neondb',
  })

  assert.equal(resolved.status, 'wrong_central_host')
  assert.equal(resolved.url, null)
  assert.equal(resolved.host, 'ep-hidden-dust-acu81nrx-pooler.sa-east-1.aws.neon.tech')
})

test('recusa URL canônica inválida sem tentar fallback', () => {
  const resolved = resolveAgentsDbSource({ AGENTS_DATABASE_URL: 'not-a-postgres-url' })

  assert.equal(resolved.status, 'invalid_canonical_url')
  assert.equal(resolved.url, null)
})
