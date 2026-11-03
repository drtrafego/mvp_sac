import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

let batchCalls = 0
let batchStatementCount = 0

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
    values: () => ({
      onConflictDoNothing: () => ({
        returning: async () => [{ id: 1 }],
      }),
    }),
  }),
  batch: async (statements: readonly unknown[]) => {
    batchCalls++
    batchStatementCount = statements.length
    return [[{ id: 1 }], []]
  },
}

mock.module('@/lib/db', { namedExports: { db } })

test('Instagram usa um único batch Neon para tags e mensagem', async () => {
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

  assert.equal(batchCalls, 1)
  assert.equal(batchStatementCount, 2)
  assert.deepEqual(result, {
    matched: ['instagram_qualificado'],
    applied: ['instagram_qualificado'],
  })
})
