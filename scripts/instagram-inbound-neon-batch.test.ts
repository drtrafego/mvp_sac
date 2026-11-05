import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

let messageInserts = 0
let tagInserts = 0

const db = {
  select: () => ({
    from: () => ({
      where: async () => [{
        trigger: 'direct',
        keywords: 'preço',
        matchType: 'contains',
        tag: 'instagram_qualificado',
        isActive: true,
      }],
    }),
  }),
  insert: () => ({
    values: (value: Record<string, unknown>) => ({
      onConflictDoNothing: () => ({
        returning: async () => {
          if ('externalId' in value) {
            messageInserts++
            return [{ id: 1 }]
          }
          tagInserts++
          return [{ id: 2 }]
        },
      }),
    }),
  }),
}

mock.module('@/lib/db', { namedExports: { db } })

test('Instagram confirma a mensagem antes de aplicar tags', async () => {
  const { persistInstagramInboundWithTags } = await import('../src/lib/instagram-inbound-tags')

  const result = await persistInstagramInboundWithTags({
    companyId: 77,
    leadId: 900,
    text: 'qual é o preço?',
    isStoryReply: false,
    message: {
      companyId: 77,
      leadId: 900,
      phone: 'ig_900',
      channel: 'instagram',
      direction: 'inbound',
      content: 'qual é o preço?',
      messageType: 'text',
      sentBy: 'user',
      externalId: 'mid-neon-batch-test',
    },
  })

  assert.equal(messageInserts, 1)
  assert.equal(tagInserts, 1)
  assert.deepEqual(result, {
    inserted: true,
    matched: ['instagram_qualificado'],
    applied: ['instagram_qualificado'],
    tagFailures: [],
  })
})
