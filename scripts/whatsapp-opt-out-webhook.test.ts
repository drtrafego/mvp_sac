import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { commercialPhrases, originalPolicy, reviewPhrases } from './whatsapp-opt-out-fixtures'
import { mock, test } from 'node:test'
import { NextRequest, NextResponse } from 'next/server'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { companies, recoveryLeads, sacAuditEvents, settings, whatsappMessages } from '../src/lib/db/schema'

const companyId = 77
const phone = '5500000000001'
const secret = 'segredo-local-do-teste'
const dialect = new PgDialect()
let slug = 'site-pronto'
let duplicate = false
let scheduledReplies = 0
const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = []
const updates: Array<{ table: unknown; patch: Record<string, unknown>; where: SQL }> = []
const cancellations: SQL[] = []

// Nenhum acesso a banco, ponte de IA ou transporte de mensagens real.
mock.method(globalThis, 'fetch', async () => { throw new Error('Rede proibida neste teste') })
mock.module('next/server', {
  namedExports: { NextRequest, NextResponse, after: () => { scheduledReplies++ } },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            assert.ok(table === settings || table === companies)
            const rows = table === companies ? [{ slug }] : [{ companyId, metaAppSecret: secret }]
            return Object.assign(Promise.resolve(rows), { limit: async () => rows })
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          inserts.push({ table, values })
          return Object.assign(Promise.resolve(), {
            onConflictDoUpdate: () => ({ returning: async () => [{ id: 901, botPaused: false }] }),
          })
        },
      }),
      update: (table: unknown) => ({
        set: (patch: Record<string, unknown>) => ({
          where: async (where: SQL) => { updates.push({ table, patch, where }) },
        }),
      }),
      execute: async (query: SQL) => { cancellations.push(query) },
    },
  },
})
mock.module('@/lib/leads', { namedExports: { markLeadContacted: async () => undefined } })
mock.module('@/lib/ai-reply', {
  namedExports: { generateAndSendAiReply: async () => { throw new Error('IA não deve rodar neste teste') } },
})
mock.module('@/lib/webhook-dedup', {
  namedExports: { isInboundMessageAlreadyProcessed: async () => duplicate, isUniqueViolation: () => false },
})

function reset(companySlug = 'site-pronto') {
  slug = companySlug
  duplicate = false
  scheduledReplies = 0
  inserts.length = 0
  updates.length = 0
  cancellations.length = 0
}

function metaRequest(message: Record<string, unknown>) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: 'numero-meta-local' },
      messages: [{ from: phone, id: 'wamid.local', ...message }],
    } }] }],
  })
  const signature = createHmac('sha256', secret).update(body).digest('hex')
  return new NextRequest('http://localhost/api/webhooks/whatsapp', {
    method: 'POST', body, headers: { 'x-hub-signature-256': `sha256=${signature}` },
  })
}

function assertOptOutEffects() {
  assert.equal(updates.length, 1)
  assert.equal(updates[0].table, recoveryLeads)
  assert.equal(updates[0].patch.whatsappConsentStatus, 'opted_out')
  assert.equal(updates[0].patch.botPaused, true)
  assert.equal(updates[0].patch.botPausedBy, 'optout_whatsapp')
  assert.ok(updates[0].patch.whatsappConsentAt instanceof Date)
  assert.ok(updates[0].patch.botPausedAt instanceof Date)
  assert.match(dialect.sqlToQuery(updates[0].patch.botControlVersion as SQL).sql, /coalesce.*\+ 1/)
  const scope = dialect.sqlToQuery(updates[0].where)
  assert.match(scope.sql, /company_id.*and.*phone/)
  assert.deepEqual(scope.params, [companyId, phone])
  assert.equal(cancellations.length, 1)
  const cancellation = dialect.sqlToQuery(cancellations[0])
  assert.match(cancellation.sql, /status = 'cancelled'/)
  assert.match(cancellation.sql, /status IN \('pending', 'processing'\)/)
  assert.match(cancellation.sql, /processing_started_at = NULL/)
  assert.deepEqual(cancellation.params, [companyId, phone])
  assert.equal(inserts.filter(row => row.table === sacAuditEvents && row.values.type === 'whatsapp_opted_out').length, 1)
  assert.equal(inserts.filter(row => row.table === whatsappMessages && row.values.direction === 'inbound').length, 1)
  assert.equal(inserts.some(row => row.values.direction === 'outbound'), false)
  assert.equal(scheduledReplies, 0)
}

function assertReviewEffects() {
  assert.equal(updates.length, 1)
  assert.equal(updates[0].table, recoveryLeads)
  assert.equal('whatsappConsentStatus' in updates[0].patch, false)
  assert.equal('whatsappConsentAt' in updates[0].patch, false)
  assert.equal(updates[0].patch.botPaused, true)
  assert.equal(updates[0].patch.botPausedBy, 'revisao_possivel_optout')
  assert.ok(updates[0].patch.botPausedAt instanceof Date)
  assert.match(dialect.sqlToQuery(updates[0].patch.botControlVersion as SQL).sql, /coalesce.*\+ 1/)
  const scope = dialect.sqlToQuery(updates[0].where)
  assert.match(scope.sql, /company_id.*and.*phone/)
  assert.deepEqual(scope.params, [companyId, phone])
  assert.equal(cancellations.length, 1)
  const cancellation = dialect.sqlToQuery(cancellations[0])
  assert.match(cancellation.sql, /status = 'cancelled'/)
  assert.match(cancellation.sql, /AND status = 'pending'/)
  assert.deepEqual(cancellation.params, [companyId, phone])
  assert.equal(inserts.filter(row => row.table === whatsappMessages && row.values.direction === 'inbound').length, 1)
  assert.equal(inserts.some(row => row.values.direction === 'outbound'), false)
  assert.equal(scheduledReplies, 0)
}

async function main() {
  const { POST } = await import('../src/app/api/webhooks/whatsapp/route')

  const original = originalPolicy()
  for (const companySlug of ['site-pronto', 'outra-empresa', 'isabela-fanini']) {
    for (const label of ['Não receber mensagens', 'Nao receber mensagens', 'No recibir mensajes', 'stop por favor']) {
      for (const title of [label, ` 🛑 ¡${label.toUpperCase().normalize('NFD').replace(/ /g, ' , \t\n ')}! `]) {
        for (const [field, message] of Object.entries({
          buttonTitle: { type: 'interactive', interactive: { button_reply: { title, id: 'id-neutro' } } },
          buttonId: { type: 'interactive', interactive: { button_reply: { title: 'Título neutro', id: title } } },
          buttonText: { type: 'button', button: { text: title, payload: 'id-neutro' } },
          buttonPayload: { type: 'button', button: { text: 'Título neutro', payload: title } },
        })) {
          await test(`botão ${companySlug} ${field}: ${title}`, async () => {
            reset(companySlug)
            const response = await POST(metaRequest(message))
            assert.equal(response.status, 200)
            assert.deepEqual(await response.json(), { ok: true, optedOut: true })
            assertOptOutEffects()
          })
        }
      }
    }

    for (const phrase of ['pare', 'stop', 'não quero receber']) {
      await test(`comando legado em ${companySlug}: ${phrase}`, async () => {
        reset(companySlug)
        const response = await POST(metaRequest({ type: 'text', text: { body: phrase } }))
        assert.deepEqual(await response.json(), { ok: true, optedOut: true })
        assertOptOutEffects()
      })
    }

    for (const phrase of commercialPhrases) {
      await test(`anexo B em ${companySlug}: ${phrase}`, async () => {
        reset(companySlug)
        const response = await POST(metaRequest({ type: 'text', text: { body: phrase } }))
        // Preservação da Isabela tem prioridade: 8 falsos positivos já eram da base.
        if (companySlug === 'isabela-fanini' && original.isWhatsAppOptOutText(phrase)) {
          assert.deepEqual(await response.json(), { ok: true, optedOut: true })
          assertOptOutEffects()
        } else {
          assert.deepEqual(await response.json(), { ok: true })
          assert.equal(updates.length, 0)
          assert.equal(cancellations.length, 0)
          assert.equal(scheduledReplies, 1)
        }
      })
    }

    for (const phrase of reviewPhrases) {
      await test(`texto longo em ${companySlug}: ${phrase}`, async () => {
        reset(companySlug)
        const response = await POST(metaRequest({ type: 'text', text: { body: phrase } }))
        assert.equal(response.status, 200)
        if (companySlug === 'isabela-fanini') {
          if (original.isWhatsAppOptOutText(phrase)) {
            assert.deepEqual(await response.json(), { ok: true, optedOut: true })
            assertOptOutEffects()
          } else {
            assert.deepEqual(await response.json(), { ok: true })
            assert.equal(updates.length, 0)
            assert.equal(cancellations.length, 0)
            assert.equal(scheduledReplies, 1)
          }
        } else {
          assert.deepEqual(await response.json(), { ok: true, optOutReview: true })
          assertReviewEffects()
        }
      })
    }
  }

  for (const phrase of ['não receber mensagens no meu site', 'no recibir mensajes en la web', 'dame de baja', 'me tira da lista']) {
    await test(`botão com complemento ou pedido de revisão não usa detector textual novo: ${phrase}`, async () => {
      reset()
      const response = await POST(metaRequest({ type: 'button', button: { text: phrase } }))
      assert.deepEqual(await response.json(), { ok: true })
      assert.equal(updates.length, 0)
      assert.equal(cancellations.length, 0)
      assert.equal(scheduledReplies, 1)
    })
  }

  await test('UazAPI também pausa pedido de revisão em texto livre', async () => {
    reset()
    const response = await POST(new NextRequest('http://localhost/api/webhooks/whatsapp', {
      method: 'POST',
      body: JSON.stringify({ instanceToken: 'instancia-local', data: {
        key: { fromMe: false, remoteJid: phone, id: 'uazapi.local' },
        messageType: 'conversation', message: { conversation: 'por favor no quiero recibir más mensajes de ustedes' },
      } }),
    }))
    assert.deepEqual(await response.json(), { ok: true, optOutReview: true })
    assertReviewEffects()
  })

  await test('reentrega já processada não repete os efeitos do opt-out', async () => {
    reset()
    duplicate = true
    const response = await POST(metaRequest({ type: 'button', button: { text: 'Não receber mensagens' } }))
    assert.deepEqual(await response.json(), { ok: true, duplicate: true })
    assert.equal(updates.length, 0)
    assert.equal(cancellations.length, 0)
    assert.equal(inserts.length, 0)
    assert.equal(scheduledReplies, 0)
  })
}

main().catch(error => { console.error(error); process.exitCode = 1 })
