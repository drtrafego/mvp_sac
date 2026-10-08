import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { OutboundSendInput, OutboundSendStore } from '../src/lib/outbound-send'

mock.module('@/lib/db', { namedExports: { db: {} } })
mock.module('@/lib/leads', { namedExports: { markLeadContacted: async () => {} } })
mock.module('@/lib/whatsapp', { namedExports: { sendWhatsAppMessage: async () => null } })
mock.module('@/lib/instagram', { namedExports: { sendInstagramMessage: async () => ({ ok: true }) } })
mock.module('@/lib/email/brevo', { namedExports: { sendBrevoEmail: async () => ({ ok: true }) } })

async function main() {
const { createOutboundSender, safeOutboundError } = await import('../src/lib/outbound-send')
type Row = NonNullable<Awaited<ReturnType<OutboundSendStore['find']>>>

function input(overrides: Partial<OutboundSendInput> = {}): OutboundSendInput {
  return {
    companyId: 1, clientRequestId: 'request-a', content: 'Resposta real', sentBy: 'human',
    lead: { id: 10, companyId: 1, phone: '5511999990000', channel: 'whatsapp' } as OutboundSendInput['lead'],
    ...overrides,
  }
}
function memoryStore() {
  let nextId = 0
  const rows = new Map<number, Row>()
  let touched = 0
  const store: OutboundSendStore = {
    async find(companyId, requestId) {
      const row = [...rows.values()].find(r => r.companyId === companyId && r.clientRequestId === requestId)
      return row && { ...row }
    },
    async create(values) {
      if (values.clientRequestId && [...rows.values()].some(r => r.companyId === values.companyId && r.clientRequestId === values.clientRequestId)) return undefined
      const row = { ...values, id: ++nextId, createdAt: new Date() } as Row
      rows.set(row.id, row)
      return { ...row }
    },
    async claimFailed(companyId, id) {
      const row = rows.get(id)
      if (!row || row.companyId !== companyId || row.sendState !== 'failed') return undefined
      const updated = { ...row, sendState: 'pending', sendError: null }
      rows.set(id, updated)
      return { ...updated }
    },
    async finish(companyId, id, values) {
      const row = rows.get(id)
      assert.ok(row && row.companyId === companyId)
      const updated = { ...row, ...values } as Row
      rows.set(id, updated)
      return { ...updated }
    },
    async touchLead() { touched++ },
  }
  return { store, rows, touched: () => touched }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

await test('accepted replay uses the same persisted message without a new transport', async () => {
  const mem = memoryStore(); let sends = 0
  const send = createOutboundSender({ store: mem.store, transport: async () => { sends++; return { ok: true, externalId: 'provider-1' } } })
  const first = await send(input()), repeated = await send(input())
  assert.equal(first.status, 200); assert.equal(repeated.status, 200)
  assert.equal(repeated.message?.id, first.message?.id)
  assert.equal(repeated.idempotentReplay, true)
  assert.equal(sends, 1); assert.equal(mem.rows.size, 1); assert.equal(mem.touched(), 1)
})

await test('failed retry claims the same row and actually sends again', async () => {
  const mem = memoryStore(); let sends = 0
  const send = createOutboundSender({ store: mem.store, transport: async () => ++sends === 1 ? { ok: false, error: 'Provider HTTP 400' } : { ok: true, externalId: 'provider-2' } })
  const failed = await send(input()), retried = await send(input())
  assert.equal(failed.status, 502); assert.equal(retried.status, 200)
  assert.equal(retried.message?.id, failed.message?.id)
  assert.equal(retried.message?.sendError, null)
  assert.equal(sends, 2); assert.equal(mem.rows.size, 1)
})

await test('concurrent creation and duplicate clicks run only one transport', async () => {
  const mem = memoryStore(), gate = deferred(), started = deferred(); let sends = 0
  const send = createOutboundSender({ store: mem.store, transport: async () => { sends++; started.resolve(); await gate.promise; return { ok: true } } })
  const first = send(input()); await started.promise
  const replay = await send(input())
  assert.equal(replay.status, 202); assert.equal(replay.message?.sendState, 'pending')
  gate.resolve(); assert.equal((await first).status, 200)
  assert.equal(sends, 1); assert.equal(mem.rows.size, 1)
})

await test('two concurrent failed retries cannot claim the transport twice', async () => {
  const mem = memoryStore(); let sends = 0
  const failedSender = createOutboundSender({ store: mem.store, transport: async () => ({ ok: false, error: 'rejected' }) })
  await failedSender(input())
  const gate = deferred(), started = deferred()
  const send = createOutboundSender({ store: mem.store, transport: async () => { sends++; started.resolve(); await gate.promise; return { ok: true } } })
  const first = send(input()), second = send(input()); await started.promise
  const waitResult = await second
  assert.equal(waitResult.status, 202); assert.equal(waitResult.message?.sendState, 'pending')
  gate.resolve(); assert.equal((await first).status, 200); assert.equal(sends, 1)
})

await test('uncertain transport preserves the row and never automatically resends', async () => {
  const mem = memoryStore(); let sends = 0
  const send = createOutboundSender({ store: mem.store, transport: async () => { sends++; throw new DOMException('timed out', 'TimeoutError') } })
  const uncertain = await send(input()), repeated = await send(input())
  assert.equal(uncertain.status, 202); assert.equal(uncertain.message?.sendState, 'uncertain')
  assert.equal(uncertain.isTimeout, true); assert.equal(repeated.status, 202); assert.equal(sends, 1)
})

await test('structured provider uncertainty works on every supported channel', async () => {
  for (const channel of ['whatsapp', 'instagram', 'email']) {
    const mem = memoryStore()
    const send = createOutboundSender({ store: mem.store, transport: async () => ({ ok: false, error: 'network lost', uncertain: true }) })
    const req = input({ lead: { ...input().lead, channel, email: 'cliente@example.test' } })
    const result = await send(req)
    assert.equal(result.status, 202); assert.equal(result.message?.sendState, 'uncertain')
  }
})

await test('same request key with changed content, contact, channel or subject returns409', async () => {
  const mem = memoryStore(); let sends = 0
  const send = createOutboundSender({ store: mem.store, transport: async () => { sends++; return { ok: true } } })
  const email = input({ lead: { ...input().lead, channel: 'email', email: 'cliente@example.test' }, subject: 'Assunto A' })
  await send(email)
  const conflicts = [
    { ...email, content: 'Outro texto' },
    { ...email, lead: { ...email.lead, id: 11 } },
    { ...email, lead: { ...email.lead, channel: 'whatsapp' } },
    { ...email, lead: { ...email.lead, email: 'outro@example.test' } },
    { ...email, subject: 'Assunto B' },
  ]
  for (const request of conflicts) { const result = await send(request); assert.equal(result.status, 409); assert.equal(result.message, null) }
  assert.equal(sends, 1)
})

await test('company-scoped request keys do not suppress another company send', async () => {
  const mem = memoryStore(); let sends = 0
  const send = createOutboundSender({ store: mem.store, transport: async () => { sends++; return { ok: true } } })
  await send(input())
  const result = await send(input({ companyId: 2, lead: { ...input().lead, id: 20, companyId: 2 } }))
  assert.equal(result.status, 200); assert.equal(sends, 2); assert.equal(mem.rows.size, 2)
})

await test('bookkeeping failure cannot change provider acceptance into a send failure', async () => {
  const mem = memoryStore()
  const send = createOutboundSender({ store: { ...mem.store, touchLead: async () => { throw new Error('db unavailable') } }, transport: async () => ({ ok: true, externalId: 'provider' }) })
  assert.equal((await send(input())).status, 200)
})

await test('persistence failure after provider acceptance stays non-retryable', async () => {
  const mem = memoryStore(); let sends = 0
  const send = createOutboundSender({ store: { ...mem.store, finish: async () => { throw new Error('db unavailable') } }, transport: async () => { sends++; return { ok: true } } })
  assert.equal((await send(input())).status, 202)
  assert.equal((await send(input())).status, 202)
  assert.equal(sends, 1)
})

await test('guard immediately before transport blocks a paused bot without sending', async () => {
  const mem = memoryStore(); let sends = 0
  const send = createOutboundSender({ store: mem.store, transport: async () => { sends++; return { ok: true } } })
  const result = await send(input({ beforeTransport: async () => false }))
  assert.equal(result.status, 409); assert.equal(result.message?.sendState, 'failed'); assert.equal(sends, 0)
})

await test('provider errors are strings, bounded, and credential values are redacted', () => {
  assert.equal(safeOutboundError({ message: 'API recusou' }), 'API recusou')
  assert.equal(safeOutboundError({ secret: 'do not copy object' }), 'Falha no transporte de envio.')
  const error = safeOutboundError('Bearer secret123 token=secret456 {"access_token":"secret789"}')
  assert.ok(!error.includes('secret123') && !error.includes('secret456') && !error.includes('secret789'))
  assert.equal(safeOutboundError('x'.repeat(600)).length, 500)
})

await test('invalid type/media and missing email fail before persistence or provider dispatch', async () => {
  const mem = memoryStore(); let sends = 0
  const send = createOutboundSender({ store: mem.store, transport: async () => { sends++; return { ok: true } } })
  assert.equal((await send(input({ messageType: 'template' }))).status, 400)
  assert.equal((await send(input({ messageType: 'audio' }))).status, 400)
  assert.equal((await send(input({ mediaUrl: 'https://example.test/image.png' }))).status, 400)
  assert.equal((await send(input({ lead: { ...input().lead, channel: 'email', email: null } }))).status, 400)
  assert.equal(mem.rows.size, 0); assert.equal(sends, 0)
})

}
main().catch(error => { console.error(error); process.exitCode = 1 })
