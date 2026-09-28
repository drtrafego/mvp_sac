import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

let unlockCalls = 0
let sendCalls = 0
let releaseFirstRun!: () => void
let firstRunEntered!: () => void

const firstRunStarted = new Promise<void>(resolve => { firstRunEntered = resolve })
const firstRunGate = new Promise<void>(resolve => { releaseFirstRun = resolve })

const testDb = {
  transaction: async () => {
    firstRunEntered()
    await firstRunGate
    return []
  },
}

mock.module('@/lib/db', { namedExports: { db: testDb } })
mock.module('@/lib/cron-advisory-lock', {
  namedExports: {
    tryAcquireCronDispatchLock: (() => {
      let attempts = 0
      return async () => {
        attempts++
        return attempts === 1 ? { locked: true } : null
      }
    })(),
    releaseCronDispatchLock: async () => {
      unlockCalls++
    },
  },
})
mock.module('@/lib/whatsapp', {
  namedExports: {
    sendWhatsAppMessage: async () => {
      sendCalls++
      return 'wamid.fake'
    },
  },
})
mock.module('@/lib/leads', {
  namedExports: {
    markLeadContacted: async () => undefined,
  },
})

test('cron concorrente com advisory lock ocupado retorna sem processar nem enviar mensagem', async () => {
  process.env.CRON_SECRET = 'cron-secret-test'
  const { POST } = await import('../src/app/api/cron/route')
  const makeRequest = () => new Request('https://sac.test/api/cron', {
    method: 'POST',
    headers: { Authorization: 'Bearer cron-secret-test' },
  }) as any

  const first = POST(makeRequest())
  await firstRunStarted

  const secondResponse = await POST(makeRequest())
  assert.equal(secondResponse.status, 200)
  assert.deepEqual(await secondResponse.json(), {
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: 'cron_already_running',
  })
  assert.equal(sendCalls, 0)

  releaseFirstRun()
  const firstResponse = await first
  assert.deepEqual(await firstResponse.json(), { processed: 0, sent: 0, failed: 0 })
  assert.equal(unlockCalls, 1)
})
