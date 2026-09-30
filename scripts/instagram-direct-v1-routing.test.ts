import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const instagramLead = {
  id: 902,
  companyId: 77,
  phone: 'ig_178414000000',
  channel: 'instagram',
  email: null,
  name: 'Lead Direct QA',
}

let instagramCalls = 0
let whatsappCalls = 0
const persistedMessages: Record<string, unknown>[] = []

const db = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [instagramLead],
      }),
    }),
  }),
  insert: () => ({
    values: (values: Record<string, unknown>) => {
      persistedMessages.push(values)
      return {
        returning: async () => [{
          id: 503,
          ...values,
          createdAt: new Date('2026-09-30T12:00:00.000Z'),
        }],
      }
    },
  }),
  update: () => ({
    set: () => ({ where: async () => [] }),
  }),
}

mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/agent-auth', {
  namedExports: {
    authenticateAgentRequest: async () => ({
      error: null,
      context: {
        company: { id: 77 },
        agentName: 'Agente QA',
        agentId: 12,
      },
    }),
    logAgentActivity: async () => undefined,
  },
})
mock.module('@/lib/whatsapp', {
  namedExports: {
    sendWhatsAppMessage: async () => {
      whatsappCalls++
      return 'wamid.nao-deveria-ser-chamado'
    },
  },
})
mock.module('@/lib/instagram', {
  namedExports: {
    sendInstagramMessage: async () => {
      instagramCalls++
      return { ok: true, messageId: 'igmid.v1.qa' }
    },
  },
})
mock.module('@/lib/email/brevo', {
  namedExports: { sendBrevoEmail: async () => ({ ok: true }) },
})
mock.module('@/lib/leads', { namedExports: { markLeadContacted: async () => undefined } })

async function main() {
  const { POST } = await import('../src/app/api/v1/companies/[idOrSlug]/conversations/[contact]/messages/route')

  await test('B3: endpoint v1 usa o canal do lead Instagram quando o body omite channel', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/v1/companies/empresa/conversations/lead:902/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'Resposta Direct via API v1' }),
      }),
      { params: Promise.resolve({ idOrSlug: 'empresa', contact: 'lead:902' }) },
    )

    assert.equal(response.status, 201)
    assert.equal(instagramCalls, 1)
    assert.equal(whatsappCalls, 0)
    assert.equal(persistedMessages[0]?.channel, 'instagram')

    const payload = await response.json()
    assert.equal(payload.sentMessage.channel, 'instagram')
  })

  await test('endpoint v1 ignora override conflitante para lead existente', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/v1/companies/empresa/conversations/lead:902/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'Outra resposta Direct via API v1',
          channel: 'whatsapp',
        }),
      }),
      { params: Promise.resolve({ idOrSlug: 'empresa', contact: 'lead:902' }) },
    )

    assert.equal(response.status, 201)
    assert.equal(instagramCalls, 2)
    assert.equal(whatsappCalls, 0)
    assert.equal(persistedMessages[1]?.channel, 'instagram')
  })
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
