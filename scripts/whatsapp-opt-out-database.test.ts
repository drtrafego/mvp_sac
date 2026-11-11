import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mock, test } from 'node:test'
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'
import { createSacTestDatabase } from './sac-test-pglite'

const secret = 'segredo-local-round2'
const phone = '5511999990001'
let scheduledReplies = 0
let eventId = 0

function request(content: string, id = `wamid.round2.${++eventId}`) {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
    metadata: { phone_number_id: 'meta-local-round2' },
    messages: [{ from: phone, id, type: 'text', text: { body: content } }],
  } }] }] })
  return new NextRequest('http://localhost/api/webhooks/whatsapp', {
    method: 'POST', body,
    headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` },
  })
}

async function main() {
  const fixture = await createSacTestDatabase([
    schema.companies, schema.settings, schema.recoveryLeads,
    schema.whatsappMessages, schema.messageJobs, schema.sacAuditEvents,
  ])
  const { db, pg } = fixture
  mock.method(globalThis, 'fetch', async () => { throw new Error('Rede proibida no teste') })
  mock.module('@/lib/db', { namedExports: { db } })
  mock.module('next/server', { namedExports: { NextRequest, NextResponse, after: () => { scheduledReplies++ } } })
  mock.module('@/lib/leads', { namedExports: { markLeadContacted: async () => undefined } })
  mock.module('@/lib/ai-reply', { namedExports: { generateAndSendAiReply: async () => { throw new Error('IA real proibida') } } })
  // Deduplicação, SQL e índices locais reais. Sem substituição de persistência.
  const { POST } = await import('../src/app/api/webhooks/whatsapp/route')
  try {
    await db.insert(schema.companies).values([
      { id: 77, name: 'Sites local', slug: 'site-pronto' },
      { id: 88, name: 'Outra local', slug: 'outra' },
    ])
    await db.insert(schema.settings).values({ companyId: 77, metaPhoneNumberId: 'meta-local-round2', metaAppSecret: secret })
    for (const consent of ['opted_in', 'unknown', 'opted_out']) {
      await test(`revisão persiste pausa e cancela apenas pending, preserva consentimento ${consent}, escopo e dedup`, async () => {
        await pg.exec('TRUNCATE recovery_leads, whatsapp_messages, message_jobs, sac_audit_events RESTART IDENTITY')
        scheduledReplies = 0
        const consentAt = new Date('2026-01-01T00:00:00Z')
        const leads = await db.insert(schema.recoveryLeads).values([
          { companyId: 77, phone, platform: 'import_planilha' },
          { companyId: 77, phone, platform: 'kiwify' },
          { companyId: 88, phone, platform: 'import_planilha' },
          { companyId: 77, phone: '5511888880001', platform: 'import_planilha' },
        ].map(lead => ({
          ...lead, channel: 'whatsapp', eventType: 'atendimento', status: 'pending',
          botPaused: false, botControlVersion: 7, whatsappConsentStatus: consent, whatsappConsentAt: consentAt,
        }))).returning()
        for (const lead of leads) {
          for (const status of ['pending', 'processing', 'sent', 'cancelled', 'failed']) {
            await db.insert(schema.messageJobs).values({ leadId: lead.id, status, scheduledFor: new Date(), messageOrder: 1 })
          }
        }
        const event = `wamid.persist.${consent}`
        const response = await POST(request('por favor não quero mais receber mensagens de vocês', event))
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true, optOutReview: true })
        const after = await db.select().from(schema.recoveryLeads).orderBy(schema.recoveryLeads.id)
        assert.equal(after.length, 4)
        for (const [index, lead] of after.entries()) {
          const affected = index < 2
          assert.equal(lead.whatsappConsentStatus, consent)
          assert.equal(lead.whatsappConsentAt?.toISOString(), consentAt.toISOString())
          assert.equal(lead.botPaused, affected)
          assert.equal(lead.botControlVersion, affected ? 8 : 7)
          assert.equal(lead.botPausedBy, affected ? 'revisao_possivel_optout' : null)
          if (affected) assert.ok(lead.botPausedAt instanceof Date)
          const jobs = await db.select().from(schema.messageJobs).where(eq(schema.messageJobs.leadId, lead.id)).orderBy(schema.messageJobs.id)
          assert.deepEqual(jobs.map(job => job.status), [affected ? 'cancelled' : 'pending', 'processing', 'sent', 'cancelled', 'failed'])
        }
        assert.equal(scheduledReplies, 0)
        const repeated = await POST(request('por favor não quero mais receber mensagens de vocês', event))
        assert.deepEqual(await repeated.json(), { ok: true, duplicate: true })
        assert.deepEqual(await db.select().from(schema.recoveryLeads).orderBy(schema.recoveryLeads.id), after)
        const inbound = await db.select().from(schema.whatsappMessages)
        assert.equal(inbound.length, 1)
        assert.equal(inbound[0].direction, 'inbound')
        assert.equal((await db.select().from(schema.sacAuditEvents)).length, 0, 'não registra opt-out confirmado')
        const subsequent = await POST(request('obrigado'))
        assert.deepEqual(await subsequent.json(), { ok: true })
        assert.equal(scheduledReplies, 0, 'pausa persistida bloqueia IA nas próximas mensagens')
      })
    }
  } finally {
    await fixture.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
