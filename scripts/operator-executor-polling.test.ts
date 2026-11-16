import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { claimBodySchema } from '../src/lib/operator/executor/contract'
let since = 0
let claims = 0
mock.module('@/lib/operator/executor/queue', { namedExports: { reclamar: async (_executor: unknown, _body: unknown, idle: (since: number) => void) => { claims++; idle(since); return null } } })
mock.module('@/lib/operator/executor/auth', { namedExports: {
  authenticateExecutor: async () => ({ id: 'synthetic', empresas: [1] }),
  executorBody: async (request: Request) => claimBodySchema.parse(await request.json()),
  executorError: () => new Response(null, { status: 500 }),
  executorResponse: (_body: unknown, status: number) => new Response(null, { status }),
} })
test('R3 long-poll usa 2s recente, 5s com jitter ocioso e termina antes de 25s', async () => {
  const { POST } = await import('../src/app/api/operator-executor/claim/route')
  for (const age of [0, 61_000]) {
    let now = 1_000_000; const waits: number[] = []; since = now - age; claims = 0
    const date = mock.method(Date, 'now', () => now)
    const timer = mock.method(globalThis, 'setTimeout', ((callback: () => void, interval: number) => {
      waits.push(interval); now += interval; queueMicrotask(callback)
      return {} as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)
    try {
      const response = await POST(new Request('https://sac.test/api/operator-executor/claim', { method: 'POST', body: JSON.stringify({ versao: 'r3', estado: 'pronto' }) }))
      assert.equal(response.status, 204)
      assert.equal(claims, waits.length + 1)
      assert.ok(now - 1_000_000 < 25_000)
      assert.ok(waits.length > 0)
      assert.ok(waits.every(ms => age ? ms >= 4500 && ms < 5500 : ms === 2000))
      assert.ok(age ? claims <= 6 : claims === 13)
    } finally { timer.mock.restore(); date.mock.restore() }
  }
})
