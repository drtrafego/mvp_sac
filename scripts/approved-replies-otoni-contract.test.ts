import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const route = readFileSync(new URL('../src/app/api/approved-replies/route.ts', import.meta.url), 'utf8')
const auth = readFileSync(new URL('../src/lib/agent-auth.ts', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../drizzle/0035_sac_approved_replies_otoni_scope.sql', import.meta.url), 'utf8')
const rollback = readFileSync(new URL('../drizzle/0035_sac_approved_replies_otoni_scope.rollback.sql', import.meta.url), 'utf8')

test('adaptador Otoni mantém o contrato legado e fixa o tenant', () => {
  assert.match(route, /authenticateAgentRequest\(req, '25394'\)/)
  assert.match(route, /companyId: 25394/)
  assert.match(route, /tenantId.*25394|requestedTenant.*25394/)
  assert.match(route, /SCOPE_DENIED/)
  assert.match(route, /idempotencyKey/)
  assert.match(route, /onConflictDoNothing/)
})

test('payload limita nome, tipo JSONB de variáveis e não aceita chave forjada', () => {
  assert.match(route, /typeof body\.title !== 'string'/)
  assert.match(route, /Array\.isArray\(body\.variables\)/)
  assert.match(route, /\^\[A-Za-z\]\[A-Za-z0-9_\]/)
  assert.match(route, /body\.tenantId \?\? body\.companyId/)
  assert.match(route, /Este agente só pode salvar variáveis em rascunho/)
})

test('allowlist não transforma o perfil dedicado em administrador', () => {
  assert.match(auth, /if \(restrictedProfile && finalCompany\)/)
  assert.match(auth, /legacyApprovedReplies/)
  assert.match(auth, /SCOPE_DENIED/)
})

test('migração cria idempotência por tenant', () => {
  assert.match(migration, /idempotency_key/)
  assert.match(migration, /company_id, idempotency_key/)
  assert.match(rollback, /DROP INDEX IF EXISTS sac_approved_replies_company_idempotency_unique/)
  assert.match(rollback, /DROP COLUMN IF EXISTS idempotency_key/)
})
