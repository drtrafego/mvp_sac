import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

let failMessageInsert = true
let committedMessages = 0

const tx = {
  select: () => ({ from: () => ({ where: async () => [] }) }),
  insert: () => ({
    values: (value: Record<string, unknown>) => {
      if ('tag' in value) return { onConflictDoNothing: () => ({ returning: async () => [] }) }
      if (failMessageInsert) return Promise.reject(new Error('falha simulada no insert da mensagem'))
      committedMessages++
      return Promise.resolve([])
    },
  }),
}

const db = {
  transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>) => callback(tx),
}

mock.module('@/lib/db', { namedExports: { db } })

test('falha atômica não confirma mensagem e uma nova tentativa local recupera', async () => {
  const { InstagramInboundPersistenceError, persistInstagramInboundWithTags } = await import('../src/lib/instagram-inbound-tags')
  const input = {
    companyId: 77,
    leadId: 900,
    text: 'quero',
    isStoryReply: false,
    message: { companyId: 77, leadId: 900, phone: 'ig_900', channel: 'instagram', direction: 'inbound', content: 'quero', messageType: 'text', sentBy: 'user' },
  } as const

  await assert.rejects(() => persistInstagramInboundWithTags(input), InstagramInboundPersistenceError)
  assert.equal(committedMessages, 0)

  failMessageInsert = false
  await persistInstagramInboundWithTags(input)
  assert.equal(committedMessages, 1)
})
