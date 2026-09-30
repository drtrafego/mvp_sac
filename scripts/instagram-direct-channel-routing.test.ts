import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { resolveLeadDeliveryChannel } from '../src/lib/lead-delivery-channel'

const platformOnlyLead = {
  id: 901,
  companyId: 77,
  phone: '5511999999999',
  channel: null,
  platform: 'instagram',
  trackingSource: null,
  email: null,
  name: 'Lead QA',
  productName: null,
}

let instagramCalls = 0
let whatsappCalls = 0

const db = {
  select: () => ({
    from: () => ({
      where: async () => [platformOnlyLead],
    }),
  }),
  insert: () => ({
    values: () => ({
      returning: async () => [{
        id: 501,
        phone: platformOnlyLead.phone,
        channel: 'whatsapp',
        direction: 'outbound',
        content: 'Resposta QA',
        messageType: 'text',
        mediaUrl: null,
        sentBy: 'human',
        createdAt: new Date('2026-09-30T12:00:00.000Z'),
      }],
    }),
  }),
  update: () => ({
    set: () => ({ where: async () => [] }),
  }),
}

mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/auth', { namedExports: { requireCompany: async () => ({ id: 77 }) } })
mock.module('@/lib/whatsapp', {
  namedExports: {
    sendWhatsAppMessage: async () => {
      whatsappCalls++
      return 'wamid.qa'
    },
  },
})
mock.module('@/lib/instagram', {
  namedExports: {
    sendInstagramMessage: async () => {
      instagramCalls++
      return { ok: true, messageId: 'igmid.qa' }
    },
  },
})
mock.module('@/lib/email/brevo', {
  namedExports: { sendBrevoEmail: async () => ({ ok: true }) },
})
mock.module('@/lib/leads', { namedExports: { markLeadContacted: async () => undefined } })
mock.module('@/lib/inbox-messages', {
  namedExports: {
    decodeMessageCursor: () => null,
    INBOX_MESSAGE_PAGE_SIZE: 50,
    INBOX_MESSAGE_PAGE_SIZE_MAX: 100,
    loadInboxMessagePage: async () => ({ messages: [], hasMore: false, nextCursor: null }),
  },
})
mock.module('@/components/inbox/ChatWindow', {
  namedExports: { ChatWindow: () => null },
})
mock.module('next/navigation', {
  namedExports: {
    notFound: (): never => {
      throw new Error('NEXT_NOT_FOUND')
    },
  },
})

async function main() {
  const { ConversationChatPage } = await import('../src/components/inbox/ConversationChatPage')
  const { POST } = await import('../src/app/api/inbox/[leadId]/route')

  await test('B1: gate e POST usam o mesmo transporte para platform=instagram sem channel/prefixo', async () => {
    assert.equal(resolveLeadDeliveryChannel(platformOnlyLead), 'whatsapp')

    await assert.rejects(
      () => ConversationChatPage({
        leadId: String(platformOnlyLead.id),
        backHref: '/instagram',
        requiredChannel: 'instagram',
      }),
      /NEXT_NOT_FOUND/,
    )

    const response = await POST(
      new NextRequest(`http://localhost/api/inbox/${platformOnlyLead.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'Resposta QA' }),
      }),
      { params: Promise.resolve({ leadId: String(platformOnlyLead.id) }) },
    )

    assert.equal(response.status, 200)
    assert.equal((await response.json()).channel, 'whatsapp')
    assert.equal(instagramCalls, 0)
    assert.equal(whatsappCalls, 1)
  })

  await test('resolvedor preserva os dois sinais operacionais reais do Direct', () => {
    assert.equal(resolveLeadDeliveryChannel({ channel: 'Instagram', phone: '551100000001' }), 'instagram')
    assert.equal(resolveLeadDeliveryChannel({ channel: null, phone: 'IG_178414000000' }), 'instagram')
  })
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
