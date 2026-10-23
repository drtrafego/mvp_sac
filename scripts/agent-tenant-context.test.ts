import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, delimiter } from 'node:path'

const localRequire = createRequire(import.meta.url)
const moduleRuntime = localRequire('node:module')
const compiledRoot = dirname(dirname(localRequire.resolve('next/dist/compiled/server-only/package.json')))
process.env.NODE_PATH = [compiledRoot, process.env.NODE_PATH].filter(Boolean).join(delimiter)
moduleRuntime._initPaths()

const mockModule = (specifier: string, namedExports: Record<string, unknown>) =>
  (mock as unknown as { module: (name: string, options: { namedExports: Record<string, unknown> }) => unknown }).module(specifier, { namedExports })

mockModule(localRequire.resolve('server-only'), {})
mockModule('@/stack', { stackServerApp: null })
mockModule('next/headers', {
  cookies: async () => ({ get: (name: string) => name === 'agent_auth_session' ? { value: 'signed-session' } : undefined }),
})
mockModule('@/lib/agent-session', {
  verifyAgentSessionCookie: async () => ({
    id: 'agent',
    primaryEmail: 'agent@example.test',
    displayName: 'Agente',
    isAdmin: true,
    companyId: 42,
    exp: Date.now() + 60_000,
  }),
})

const resolvedCompany = { id: 42, slug: 'tenant-explicito', name: 'Tenant explícito' }
const db = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [resolvedCompany],
      }),
    }),
  }),
}
mockModule('@/lib/db', { db })

test('sessão de agente usa o tenant assinado, sem cair no tenant padrão', async () => {
  const { explicitAgentCompanyId, getCurrentCompany } = await import('../src/lib/auth')
  assert.equal(explicitAgentCompanyId({ companyId: 42 }), 42)
  assert.equal(explicitAgentCompanyId({ companyId: 0 }), null)
  assert.equal((await getCurrentCompany())?.id, 42)
})
