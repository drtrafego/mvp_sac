import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

let failTagInsert = true
let committedMessages = 0
let tagAttempts = 0
const insertedExternalIds = new Set<string>()

const db = {
  select: () => ({ from: () => ({ where: async () => [] }) }),
  insert: () => ({
    values: (value: Record<string, unknown>) => ({
      onConflictDoNothing: () => ({
        returning: async () => {
          if ('tag' in value) {
            tagAttempts++
            if (failTagInsert) throw new Error('falha simulada na tag; token=nao-deve-vazar')
            return [{ id: tagAttempts }]
          }
          const externalId = String(value.externalId ?? '')
          if (insertedExternalIds.has(externalId)) return []
          insertedExternalIds.add(externalId)
          committedMessages++
          return [{ id: committedMessages }]
        },
      }),
    }),
  }),
}

mock.module('@/lib/db', { namedExports: { db } })

test('falha de tag não reverte mensagem e reentrega mantém idempotência', async () => {
  const { persistInstagramInboundWithTags } = await import('../src/lib/instagram-inbound-tags')
  const input = {
    companyId: 77,
    leadId: 900,
    text: 'quero',
    isStoryReply: false,
    additionalTags: [{ tag: 'instagram_direct', createdBy: 'system:instagram_direct' }],
    message: { companyId: 77, leadId: 900, phone: 'ig_900', channel: 'instagram', direction: 'inbound', content: 'quero', messageType: 'text', sentBy: 'user' },
    }

  const first = await persistInstagramInboundWithTags({ ...input, message: { ...input.message, externalId: 'mid-partial-failure' } })
  assert.equal(first.inserted, true)
  assert.equal(committedMessages, 1, 'a mensagem confirmada não pode depender da tag')
  assert.equal(first.tagFailures.length, 1)
  assert.match(first.tagFailures[0].error, /falha simulada na tag/)
  assert.doesNotMatch(first.tagFailures[0].error, /nao-deve-vazar/)

  failTagInsert = false
  const retry = await persistInstagramInboundWithTags({ ...input, message: { ...input.message, externalId: 'mid-partial-failure' } })
  assert.equal(retry.inserted, false, 'a reentrega não pode criar outra mensagem')
  assert.equal(committedMessages, 1)
  assert.equal(retry.tagFailures.length, 0, 'a reentrega pode reparar a tag sem duplicar o inbound')
  assert.equal(tagAttempts, 2)
})
