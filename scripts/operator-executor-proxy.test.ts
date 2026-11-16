import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { NextRequest } from 'next/server'
mock.module('@/stack.middleware', { namedExports: { stackMiddlewareApp: { getUser: async () => null } } })

test('R3 proxy libera só executor exato ou seguido de barra e protege caminho vizinho', async () => {
  const previous = process.env.STACK_PROJECT_ID
  process.env.STACK_PROJECT_ID = 'synthetic-project'
  try {
    const { proxy } = await import('../src/proxy')
    for (const path of ['/api/operator-executor', '/api/operator-executor/claim', '/api/operator-executor/jobs/id/complete']) assert.equal((await proxy(new NextRequest('https://sac.test' + path))).status, 200)
    for (const path of ['/api/operator-executor-malicioso', '/api/operator-executors', '/api/operator-executorqualquercoisa', '/api/operator/messages']) assert.equal((await proxy(new NextRequest('https://sac.test' + path))).status, 401, path)
  } finally {
    if (previous === undefined) delete process.env.STACK_PROJECT_ID
    else process.env.STACK_PROJECT_ID = previous
  }
})
