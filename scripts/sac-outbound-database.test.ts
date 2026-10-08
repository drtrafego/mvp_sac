// Real production sender/store and message loader against a disposable PGlite
// PostgreSQL engine. Only external transports are mocked; this exercises the
// actual unique index, INSERT ON CONFLICT, conditional retry UPDATE and reload.
// PGLITE_MODULE may point to an externally installed @electric-sql/pglite.
// node --experimental-test-module-mocks --import tsx --test scripts/sac-outbound-database.test.ts
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'
import { createSacTestDatabase } from './sac-test-pglite'
import type { OutboundSendInput } from '../src/lib/outbound-send'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function main() {
  const fixture = await createSacTestDatabase([schema.companies, schema.recoveryLeads, schema.whatsappMessages])
  const { db } = fixture
  let transports = 0
  let behavior: () => Promise<string | null> = async () => 'wamid.test'
  mock.module('@/lib/db', { namedExports: { db } })
  mock.module('@/lib/whatsapp', { namedExports: { sendWhatsAppMessage: async () => { transports++; return behavior() } } })
  mock.module('@/lib/instagram', { namedExports: { sendInstagramMessage: async () => ({ ok: true, messageId: 'ig.test' }) } })
  mock.module('@/lib/email/brevo', { namedExports: { sendBrevoEmail: async () => ({ ok: true, data: { messageId: 'email.test' } }) } })

  const { sendOutboundForLead } = await import('../src/lib/outbound-send')
  const { loadInboxMessagePage } = await import('../src/lib/inbox-messages')
  let seed = 0
  async function request(key: string): Promise<OutboundSendInput> {
    const [company] = await db.insert(schema.companies).values({ name: 'Teste SAC', slug: `db-outbound-${++seed}` }).returning()
    const [lead] = await db.insert(schema.recoveryLeads).values({ companyId: company.id, phone: `551199999${String(seed).padStart(4, '0')}`, channel: 'whatsapp', eventType: 'atendimento' }).returning()
    return { companyId: company.id, lead, content: 'Resposta de teste', sentBy: 'human', clientRequestId: key }
  }
  try {
    await test('actual failed retry CAS reuses one row and reloads accepted state', async () => {
      transports = 0
      const req = await request('database-retry')
      behavior = async () => { throw new Error('Meta API erro 400: definitive rejection') }
      const first = await sendOutboundForLead(req)
      assert.equal(first.status, 502); assert.equal(first.message?.sendState, 'failed')
      const failedPage = await loadInboxMessagePage({ companyId: req.companyId, leadId: req.lead.id, phone: req.lead.phone })
      assert.equal(failedPage.messages[0].sendState, 'failed')
      assert.match(failedPage.messages[0].sendError!, /definitive rejection/)
      assert.equal(failedPage.messages[0].clientRequestId, req.clientRequestId)
      behavior = async () => 'wamid.retry'
      const retry = await sendOutboundForLead(req)
      assert.equal(retry.status, 200); assert.equal(retry.message?.id, first.message?.id)
      assert.equal(retry.message?.externalId, 'wamid.retry'); assert.equal(transports, 2)
      const reload = await loadInboxMessagePage({ companyId: req.companyId, leadId: req.lead.id, phone: req.lead.phone })
      assert.equal(reload.messages.length, 1); assert.equal(reload.messages[0].sendState, 'accepted'); assert.equal(reload.messages[0].sendError, null)
      const [lead] = await db.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.id, req.lead.id))
      assert.ok(lead.firstContactAt, 'production bookkeeping runs only after acceptance')
    })

    await test('actual partial unique index rejects a duplicate and concurrent retries send once', async () => {
      transports = 0
      const req = await request('database-concurrency')
      behavior = async () => { throw new Error('Meta API erro 400: rejected') }
      const failed = await sendOutboundForLead(req)
      await assert.rejects(() => db.insert(schema.whatsappMessages).values({
        companyId: req.companyId, leadId: req.lead.id, phone: req.lead.phone,
        direction: 'outbound', clientRequestId: req.clientRequestId,
      }).returning(), (error: unknown) => {
        const value = error as { code?: string; cause?: { code?: string } }
        return (value.code || value.cause?.code) === '23505'
      })
      const gate = deferred(), started = deferred()
      behavior = async () => { started.resolve(); await gate.promise; return 'wamid.single-retry' }
      const countBefore = transports
      const first = sendOutboundForLead(req), second = sendOutboundForLead(req)
      await started.promise
      const duplicate = await Promise.race([first, second])
      assert.equal(duplicate.status, 202); assert.equal(duplicate.message?.sendState, 'pending')
      gate.resolve()
      const results = await Promise.all([first, second])
      const accepted = results.find(result => result.status === 200)!
      assert.deepEqual(results.map(result => result.status).sort(), [200, 202])
      assert.equal(accepted.message?.id, failed.message?.id)
      assert.equal(transports - countBefore, 1)
    })

    await test('production sender validates persisted hash and never sends a changed payload', async () => {
      transports = 0
      const req = await request('database-payload')
      behavior = async () => 'wamid.accepted'
      const accepted = await sendOutboundForLead(req)
      assert.equal(accepted.status, 200)
      const conflict = await sendOutboundForLead({ ...req, content: 'Nova resposta que não pode ser descartada' })
      assert.equal(conflict.status, 409); assert.equal(conflict.message, null)
      const repeated = await sendOutboundForLead(req)
      assert.equal(repeated.status, 200); assert.equal(repeated.idempotentReplay, true); assert.equal(transports, 1)
    })

    await test('uncertain provider result remains visible on reload and suppresses retry', async () => {
      transports = 0
      const req = await request('database-uncertain')
      behavior = async () => { throw new DOMException('Timeout após envio', 'TimeoutError') }
      const result = await sendOutboundForLead(req)
      assert.equal(result.status, 202); assert.equal(result.message?.sendState, 'uncertain')
      const page = await loadInboxMessagePage({ companyId: req.companyId, leadId: req.lead.id, phone: req.lead.phone })
      assert.equal(page.messages[0].sendState, 'uncertain'); assert.equal(page.messages[0].clientRequestId, req.clientRequestId)
      assert.equal((await sendOutboundForLead(req)).status, 202); assert.equal(transports, 1)
    })
  } finally {
    await fixture.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
