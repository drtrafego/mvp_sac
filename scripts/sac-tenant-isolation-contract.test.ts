import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname } from 'node:path'

const localRequire = createRequire(import.meta.url)
const moduleRuntime = localRequire('node:module')
const compiledRoot = dirname(dirname(localRequire.resolve('next/dist/compiled/server-only/package.json')))
process.env.NODE_PATH = [compiledRoot, process.env.NODE_PATH].filter(Boolean).join(delimiter)
moduleRuntime._initPaths()

process.env.AGENT_SESSION_SECRET = 'tenant-isolation-test-secret'
;(mock as unknown as { module: (name: string, options: { namedExports: Record<string, unknown> }) => void }).module(localRequire.resolve('server-only'), { namedExports: {} })

test('seleção de tenant Isabella não pode ser reutilizada por AutonomIA nem por outro usuário', async () => {
  const { createTenantSelectionCookie, verifyTenantSelectionCookie } = await import('../src/lib/agent-session')
  const isabellaCompanyId = 2
  const autonomiaCompanyId = 292
  const cookie = await createTenantSelectionCookie('isabella-session-user', isabellaCompanyId)

  assert.equal(await verifyTenantSelectionCookie(cookie, 'isabella-session-user'), isabellaCompanyId)
  assert.equal(await verifyTenantSelectionCookie(cookie, 'autonomia-session-user'), null)
  assert.notEqual(await verifyTenantSelectionCookie(cookie, 'isabella-session-user'), autonomiaCompanyId)
  assert.equal(await verifyTenantSelectionCookie(`${cookie}tampered`, 'isabella-session-user'), null)
})

test('contexto de navegador falha fechado e respostas de inbox não podem ser cacheadas', () => {
  const auth = fs.readFileSync(new URL('../src/lib/auth.ts', import.meta.url), 'utf8')
  const inbox = fs.readFileSync(new URL('../src/app/api/inbox/route.ts', import.meta.url), 'utf8')
  const counts = fs.readFileSync(new URL('../src/app/api/inbox/counts/route.ts', import.meta.url), 'utf8')

  assert.doesNotMatch(auth, /autonomiaCompany|admin_viewing_slug|headerStore\.get\('x-company-slug'\)/)
  assert.match(auth, /verifyTenantSelectionCookie\(cookieStore\.get\('tenant_viewing'\)/)
  assert.match(inbox, /Cache-Control.*no-store/)
  assert.match(counts, /Cache-Control.*no-store/)
})
