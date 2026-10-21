import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, delimiter } from 'node:path'

const localRequire = createRequire(import.meta.url)
const moduleRuntime = localRequire('node:module')
const compiledRoot = dirname(dirname(localRequire.resolve('next/dist/compiled/server-only/package.json')))
process.env.NODE_PATH = [compiledRoot, process.env.NODE_PATH].filter(Boolean).join(delimiter)
moduleRuntime._initPaths()

const mockModule = (name: string, namedExports: Record<string, unknown>) =>
  (mock as unknown as { module: (specifier: string, options: { namedExports: Record<string, unknown> }) => unknown }).module(name, { namedExports })

mockModule(localRequire.resolve('server-only'), {})
mockModule('@/stack', { stackServerApp: null })
mockModule('next/headers', {
  cookies: async () => ({ get: (name: string) => name === 'agent_auth_session' ? { value: 'signed-session' } : undefined }),
  headers: async () => ({ get: () => null }),
})
mockModule('@/lib/agent-session', {
  verifyAgentSessionCookie: async () => ({
    id: 'agent', primaryEmail: 'agent@example.test', displayName: 'Agente', isAdmin: true, companyId: 42, exp: Date.now() + 60_000,
  }),
})

const explicitCompany = { id: 42, slug: 'tenant-explicito', name: 'Tenant explícito' }
mockModule('@/lib/db', {
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [explicitCompany] }) }) }),
  },
})

test('sessão assinada preserva o tenant explícito sem fallback para outra empresa', async () => {
  const { explicitAgentCompanyId, getCurrentCompany } = await import('../src/lib/auth')
  assert.equal(explicitAgentCompanyId({ companyId: 42 }), 42)
  assert.equal(explicitAgentCompanyId({ companyId: 0 }), null)
  assert.equal((await getCurrentCompany())?.id, 42)
})
